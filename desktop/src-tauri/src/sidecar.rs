//! El server como proceso aparte: descubrir, lanzar, adoptar, supervisar y detener.
//!
//! Todo pasa en un hilo propio que procesa pedidos en orden (arranque, botones de la pantalla
//! local, salida) y, entre pedido y pedido, revisa cómo está el server. La ventana ya está
//! abierta con "cargando" mientras tanto: nada de esto la bloquea.
//!
//! Reglas que no se rompen:
//! - A un server ajeno nunca se le manda una señal ni se lo relanza solo.
//! - Antes de cada señal al propio se confirma con un health recién pedido que es el mismo
//!   (pid y launchId), salvo que sea hijo directo todavía sin cosechar.
//! - El server lanzado vive en su propia sesión, con stdin en /dev/null y la salida a un
//!   archivo: si el usuario elige "dejarlo corriendo", sigue vivo cuando la app se cierra.

use std::collections::BTreeMap;
use std::fs::File;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

use crate::health::{self, Health, Probe};
use crate::launch_env::LaunchEnv;
use crate::policy::{self, Answer, Busy, ExitAction, Restart, RestartPolicy, ServerKind};
use crate::screen::{self, Action, Request, Screen};
use crate::server_log;
use crate::server_state::{self, Expected, Owner, StateFile};
use crate::settings::Settings;
use crate::window;
use crate::AppState;

/// Cada cuánto se mira el server mientras arranca.
const STARTING_TICK: Duration = Duration::from_millis(200);
/// Cada cuánto se mira el server propio lanzado por esta corrida (try_wait, sin red).
const CHILD_TICK: Duration = Duration::from_millis(500);
/// Cada cuánto se pide el health de un server adoptado o ajeno.
const HEALTH_TICK: Duration = Duration::from_secs(2);
const SLOW_AFTER: Duration = Duration::from_secs(30);
/// Un server ajeno que no responde durante esto se da por detenido.
const FOREIGN_GRACE: Duration = Duration::from_secs(10);
const STOP_GRACE: Duration = Duration::from_secs(15);
const NODEJS_URL: &str = "https://nodejs.org/";

/// Lo que la app le pide al sidecar desde afuera de su hilo.
enum Cmd {
    Action(Request),
    Exit,
}

/// Los pedidos pendientes del sidecar (se crean con el estado y los consume su hilo).
pub struct Inbox(mpsc::Receiver<Cmd>);

pub type OnServer = Box<dyn Fn(&AppHandle, Option<u16>) + Send + Sync>;
pub type Notify = Box<dyn Fn(&AppHandle, &str, &str) + Send + Sync>;
pub type Running = Box<dyn Fn(&AppHandle) -> Option<u32> + Send + Sync>;

/// Lo que el resto de la app (bandeja, WS, avisos) necesita del sidecar.
pub struct Hooks {
    /// Hay (o dejó de haber) un server en este puerto: para reconectar el WS de escritorio.
    pub on_server: OnServer,
    /// Un aviso nativo (título, texto).
    pub notify: Notify,
    /// Cuántas sesiones corta detener el server (`running` del resumen), si se sabe.
    pub running: Running,
}

/// Estado del sidecar que se comparte con la app (`app.state::<Sidecar>()`).
pub struct Sidecar {
    tx: Mutex<Sender<Cmd>>,
    /// El puerto al que la ventana puede navegar (0: ninguno). Lo lee la guarda de navegación.
    guard: Arc<AtomicU16>,
    token: String,
    /// La salida ya se decidió: el próximo `ExitRequested` pasa.
    exit_ok: AtomicBool,
    /// El sistema se está apagando o cerrando la sesión (macOS): salir sin preguntar.
    system_ending: Arc<AtomicBool>,
    log: Mutex<Option<PathBuf>>,
}

impl Sidecar {
    /// El puerto del server que muestra la ventana, si hay uno.
    pub fn port(&self) -> Option<u16> {
        Some(self.guard.load(Ordering::SeqCst)).filter(|p| *p != 0)
    }

    pub fn guard(&self) -> Arc<AtomicU16> {
        Arc::clone(&self.guard)
    }

    pub fn token(&self) -> String {
        self.token.clone()
    }

    pub fn action(&self, req: Request) {
        let _ = self.tx.lock().expect("sidecar").send(Cmd::Action(req));
    }

    /// `RunEvent::ExitRequested`: devuelve true si hay que frenar la salida (el sidecar decide).
    pub fn intercept_exit(&self) -> bool {
        if self.exit_ok.load(Ordering::SeqCst) {
            return false;
        }
        // Si el hilo del sidecar ya no está, la salida no se frena (si no, no se podría salir).
        self.tx.lock().expect("sidecar").send(Cmd::Exit).is_ok()
    }

    pub fn log_path(&self) -> Option<PathBuf> {
        self.log.lock().expect("sidecar").clone()
    }

    pub fn system_ending_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.system_ending)
    }
}

/// Crea el estado del sidecar (antes de la ventana, que necesita la guarda y el token).
pub fn create(app: &AppHandle) -> Inbox {
    let (tx, rx) = mpsc::channel();
    app.manage(Sidecar {
        tx: Mutex::new(tx),
        guard: Arc::new(AtomicU16::new(0)),
        token: screen::random_hex(),
        exit_ok: AtomicBool::new(false),
        system_ending: Arc::new(AtomicBool::new(false)),
        log: Mutex::new(None),
    });
    Inbox(rx)
}

/// Arranca el hilo del sidecar: lee el entorno, busca o lanza el server y lo supervisa.
pub fn start(app: AppHandle, inbox: Inbox, hooks: Hooks) {
    thread::Builder::new()
        .name("sidecar".into())
        .spawn(move || Worker::new(app, hooks).run(inbox.0))
        .expect("no pude crear el hilo del sidecar");
}

/// Abre el log del server con el programa del sistema ("Ver log").
pub fn open_log<R: tauri::Runtime>(app: &AppHandle<R>) {
    let path = app.state::<Sidecar>().log_path();
    match path {
        Some(p) if p.exists() => {
            if let Err(e) = tauri_plugin_opener::open_path(&p, None::<&str>) {
                eprintln!("No pude abrir el log: {e}");
            }
        }
        _ => eprintln!("Todavía no hay log del server."),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn pid_alive(pid: u32) -> bool {
    // SAFETY: la señal 0 solo pregunta si el proceso existe.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

/// Señal a un hijo directo todavía sin cosechar (su pid no se puede reusar).
fn signal_child(pid: u32, sig: libc::c_int) {
    // SAFETY: solo se llama con el pid de un `Child` que try_wait todavía da vivo.
    unsafe {
        libc::kill(pid as libc::pid_t, sig);
    }
}

fn signal_group(pgid: u32, sig: libc::c_int) {
    // SAFETY: el grupo del server propio (lo lanzó la app con setsid); solo se llama con el líder
    // sin cosechar o con un health recién pedido que confirma que el server sigue ahí.
    unsafe {
        libc::kill(-(pgid as libc::pid_t), sig);
    }
}

/// Un proceso al que se le van a mandar señales. En Linux se abre un pidfd **antes** de
/// verificarlo con el health: si el health confirma después que ese pid es el server, las
/// señales van a ese proceso y no a otro que reuse el pid. En macOS, el pid.
struct Target {
    pid: u32,
    #[cfg(target_os = "linux")]
    fd: Option<std::os::fd::OwnedFd>,
}

impl Target {
    fn open(pid: u32) -> Self {
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::FromRawFd;
            // SAFETY: pidfd_open devuelve un fd nuevo (o -1); si es válido pasa a ser nuestro.
            let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) };
            let fd = (raw >= 0).then(|| unsafe { std::os::fd::OwnedFd::from_raw_fd(raw as i32) });
            Self { pid, fd }
        }
        #[cfg(not(target_os = "linux"))]
        Self { pid }
    }

    fn signal(&self, sig: libc::c_int) {
        #[cfg(target_os = "linux")]
        if let Some(fd) = &self.fd {
            use std::os::fd::AsRawFd;
            // SAFETY: pidfd propio; si el proceso ya terminó falla con ESRCH y no le llega a nadie.
            unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    fd.as_raw_fd(),
                    sig,
                    std::ptr::null::<libc::siginfo_t>(),
                    0u32,
                );
            }
            return;
        }
        // SAFETY: sin pidfd (macOS o un kernel viejo): el pid recién verificado por el health.
        unsafe {
            libc::kill(self.pid as libc::pid_t, sig);
        }
    }
}

/// Dónde está el bundle del server: en release, entre los recursos de la app; en desarrollo,
/// el que genera `npm run stage -w desktop` (lo corre `tauri dev` antes de compilar).
fn bundle_dir(app: &AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        if let Some(p) = std::env::var_os("CONTROL_PLANE_SERVER_BUNDLE") {
            return PathBuf::from(p);
        }
        return Path::new(env!("CARGO_MANIFEST_DIR")).join("../server-bundle");
    }
    let bundle = app
        .path()
        .resource_dir()
        .map(|d| d.join("app"))
        .unwrap_or_else(|_| PathBuf::from("app"));
    // Desde un AppImage, una copia fuera del montaje: si el server queda corriendo al salir, su
    // web y su hook siguen ahí (ver bundle_copy).
    if app.env().appimage.is_some() {
        if let Ok(data) = app.path().app_local_data_dir() {
            let version = app.package_info().version.to_string();
            match crate::bundle_copy::persistent_copy(
                &bundle,
                &data.join("server-bundle"),
                &version,
            ) {
                Ok(copy) => return copy,
                Err(e) => eprintln!("No pude copiar el server fuera del AppImage: {e}"),
            }
        }
    }
    bundle
}

/// La carpeta de datos del server. En desarrollo, si no viene definida, una temporal propia de
/// la app de desarrollo (nunca la de todos los días), y la de todos los días se rechaza.
pub fn resolve_home(
    env_home: Option<&str>,
    user_home: Option<&Path>,
    temp: &Path,
    port: u16,
    debug: bool,
    allow_real: bool,
) -> Result<Option<PathBuf>, String> {
    let given = env_home.filter(|h| !h.trim().is_empty()).map(PathBuf::from);
    if !debug {
        return Ok(given);
    }
    let real = user_home.map(|h| h.join(".control-plane"));
    match given {
        None => Ok(Some(temp.join(format!("control-plane-dev-{port}")))),
        Some(h) if !allow_real && real.as_deref().is_some_and(|r| same_dir(&h, r)) => Err(format!(
            "CONTROL_PLANE_HOME apunta a {}, la carpeta de datos de todos los días. Usá otra o definí CONTROL_PLANE_ALLOW_REAL_HOME=1.",
            h.display()
        )),
        Some(h) => Ok(Some(h)),
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canon(a) == canon(b) || a == b
}

/// Marca todos los fds de más de 2 como close-on-exec: el server no hereda nada de la app
/// (sockets de la ventana, pipes de GTK) que pueda atarlo a ella.
fn cloexec_all() {
    #[cfg(target_os = "linux")]
    // SAFETY: close_range con CLOSE_RANGE_CLOEXEC solo cambia flags; si el kernel no lo tiene,
    // falla con ENOSYS y se cae al bucle.
    unsafe {
        const CLOSE_RANGE_CLOEXEC: libc::c_uint = 1 << 2;
        if libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, CLOSE_RANGE_CLOEXEC) == 0 {
            return;
        }
    }
    // SAFETY: fcntl sobre fds que pueden no existir: falla sin efecto.
    unsafe {
        let max = libc::sysconf(libc::_SC_OPEN_MAX).clamp(256, 65536) as libc::c_int;
        for fd in 3..max {
            let flags = libc::fcntl(fd, libc::F_GETFD);
            if flags >= 0 {
                libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC);
            }
        }
    }
}

enum Phase {
    /// Mostrando una pantalla: se espera un botón.
    Idle,
    Starting {
        child: Child,
        expected: Expected,
        since: Instant,
        offset: u64,
        slow: bool,
    },
    /// El server propio: lanzado ahora (`child`) o adoptado de una corrida anterior.
    Own {
        child: Option<Child>,
        expected: Expected,
        /// Cuándo arrancó (para la política de relanzamiento).
        started_ms: u64,
        offset: u64,
        down_since: Option<Instant>,
    },
    Foreign {
        pid: Option<u32>,
        down_since: Option<Instant>,
    },
}

struct Worker {
    app: AppHandle,
    hooks: Hooks,
    launch: Option<LaunchEnv>,
    port: Option<u16>,
    /// Puerto elegido en esta corrida ("Cambiar puerto", "Usar ese"): gana sobre el resto.
    port_override: Option<u16>,
    phase: Phase,
    restarts: RestartPolicy,
    notice: Option<String>,
    home: Option<PathBuf>,
    /// El puerto del server que tiene tomada la carpeta de datos ("Usar ese").
    lock_port: Option<u16>,
    last_health: Instant,
}

impl Worker {
    fn new(app: AppHandle, hooks: Hooks) -> Self {
        Self {
            app,
            hooks,
            launch: None,
            port: None,
            port_override: None,
            phase: Phase::Idle,
            restarts: RestartPolicy::default(),
            notice: None,
            home: None,
            lock_port: None,
            last_health: Instant::now(),
        }
    }

    fn state(&self) -> tauri::State<'_, Sidecar> {
        self.app.state::<Sidecar>()
    }

    fn settings(&self) -> Settings {
        self.app.state::<AppState>().settings()
    }

    fn save_settings(&self, f: impl FnOnce(&mut Settings)) {
        self.app.state::<AppState>().update_settings(f);
    }

    fn show(&self, s: Screen) {
        let s = s.with_notice(self.notice.clone());
        eprintln!(
            "Pantalla: {}{}",
            s.title,
            if s.notice.is_some() {
                " (con aviso)"
            } else {
                ""
            }
        );
        window::show_screen(&self.app, &s, &self.state().token);
    }

    fn set_guard(&self, port: Option<u16>) {
        self.state()
            .guard
            .store(port.unwrap_or(0), Ordering::SeqCst);
    }

    fn dirs(&self) -> (PathBuf, PathBuf) {
        let p = self.app.path();
        let data = p.app_data_dir().unwrap_or_else(|_| std::env::temp_dir());
        let logs = p.app_log_dir().unwrap_or_else(|_| data.join("logs"));
        (data, logs)
    }

    fn state_file(&self, port: u16) -> PathBuf {
        server_state::state_path(&self.dirs().0, port)
    }

    // ------------------------------------------------------------------ bucle

    fn run(mut self, rx: mpsc::Receiver<Cmd>) {
        self.boot();
        loop {
            match rx.recv_timeout(self.tick()) {
                Ok(Cmd::Action(req)) => self.on_action(req),
                Ok(Cmd::Exit) => self.on_exit(),
                Err(RecvTimeoutError::Timeout) => self.on_tick(),
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    fn tick(&self) -> Duration {
        match &self.phase {
            Phase::Idle => Duration::from_secs(3600),
            Phase::Starting { .. } => STARTING_TICK,
            Phase::Own { child: Some(_), .. } => CHILD_TICK,
            Phase::Own { child: None, .. } | Phase::Foreign { .. } => HEALTH_TICK,
        }
    }

    /// Entorno, puerto y descubrimiento. También es "Reintentar".
    fn boot(&mut self) {
        self.show(Screen::loading());
        let settings = self.settings();
        let launch = LaunchEnv::prepare(&settings);
        eprintln!("{}", launch.summary());
        self.notice = launch.login.error.as_ref().map(|e| {
            screen::login_notice(&launch.login.shell.display().to_string(), &e.to_string())
        });
        let port = match self.port_override {
            Some(p) => Ok(p),
            None => window::port_from_env(launch.login_var("CONTROL_PLANE_PORT"), settings.port),
        };
        self.launch = Some(launch);
        match port {
            Ok(p) => {
                self.port = Some(p);
                self.discover(p);
            }
            Err(e) => {
                self.port = None;
                self.show(Screen::bad_port(&e.to_string()));
            }
        }
    }

    /// ¿Qué hay en el puerto? Usarlo, adoptarlo, lanzar uno o explicar por qué no.
    fn discover(&mut self, port: u16) {
        self.set_guard(None);
        self.show(Screen::looking(port));
        let state_path = self.state_file(port);
        match health::probe(port) {
            Probe::ControlPlane(h) => {
                let state = StateFile::read(&state_path);
                match server_state::owner(state.as_ref(), &h) {
                    Owner::Own => {
                        let st = state.expect("propio implica archivo");
                        eprintln!(
                            "Server propio en el puerto {port} (pid {}): lo adopto.",
                            h.pid
                        );
                        *self.state().log.lock().expect("sidecar") = Some(st.log_path.clone());
                        self.phase = Phase::Own {
                            child: None,
                            expected: Expected {
                                pid: st.pid,
                                pgid: st.pgid.unwrap_or(st.pid),
                                launch_id: st.launch_id,
                            },
                            started_ms: h.started_at,
                            offset: st.log_offset,
                            down_since: None,
                        };
                    }
                    Owner::Foreign => {
                        eprintln!("Server ajeno en el puerto {port} (pid {}): lo uso.", h.pid);
                        StateFile::remove(&state_path);
                        self.phase = Phase::Foreign {
                            pid: Some(h.pid),
                            down_since: None,
                        };
                    }
                }
                self.ready(port);
            }
            Probe::Refused => {
                StateFile::remove(&state_path);
                self.launch_server(port);
            }
            Probe::OldControlPlane => {
                self.phase = Phase::Idle;
                self.show(Screen::old_server(port));
            }
            Probe::Other(what) => {
                self.phase = Phase::Idle;
                self.show(Screen::other_program(port, &what));
            }
            Probe::Timeout => {
                self.phase = Phase::Idle;
                self.show(Screen::other_program(
                    port,
                    "Aceptó la conexión pero no respondió en 1,5 s.",
                ));
            }
        }
    }

    fn ready(&mut self, port: u16) {
        self.set_guard(Some(port));
        window::show_dashboard(&self.app, port);
        (self.hooks.on_server)(&self.app, Some(port));
        self.last_health = Instant::now();
    }

    fn lost(&mut self) {
        self.set_guard(None);
        (self.hooks.on_server)(&self.app, None);
    }

    // ------------------------------------------------------------------ lanzar

    fn launch_server(&mut self, port: u16) {
        self.phase = Phase::Idle;
        let Some(launch) = self.launch.clone() else {
            return self.boot();
        };
        let node = match &launch.node {
            Ok(n) => n.path.clone(),
            Err(e) => return self.show(Screen::no_node(&e.to_string())),
        };
        if let Err(e) = &launch.claude {
            return self.show(Screen::no_claude(&e.to_string()));
        }
        let mut env: BTreeMap<String, String> = launch.server_env.clone();
        let user_home = env.get("HOME").map(PathBuf::from);
        let allow_real = env
            .get("CONTROL_PLANE_ALLOW_REAL_HOME")
            .is_some_and(|v| v == "1");
        let home = match resolve_home(
            env.get("CONTROL_PLANE_HOME").map(String::as_str),
            user_home.as_deref(),
            &std::env::temp_dir(),
            port,
            cfg!(debug_assertions),
            allow_real,
        ) {
            Ok(h) => h,
            Err(e) => return self.show(Screen::bad_home(&e)),
        };
        let data_home = home
            .clone()
            .or_else(|| user_home.as_ref().map(|h| h.join(".control-plane")));
        self.home = data_home;
        if let Some(h) = &home {
            env.insert(
                "CONTROL_PLANE_HOME".into(),
                h.to_string_lossy().into_owned(),
            );
        }

        let bundle = bundle_dir(&self.app);
        let entry = bundle.join("server.mjs");
        if !entry.is_file() {
            return self.show(Screen::failed(&format!(
                "No encontré el server empaquetado en {}. En desarrollo se genera con `npm run stage -w desktop`.",
                entry.display()
            )));
        }
        let launch_id = screen::random_hex();
        env.insert("CONTROL_PLANE_PORT".into(), port.to_string());
        env.insert("CONTROL_PLANE_HOST".into(), "127.0.0.1".into());
        env.insert("CONTROL_PLANE_LAUNCH_ID".into(), launch_id.clone());
        env.insert("NODE_ENV".into(), "production".into());
        // El web y el hook del mismo bundle (aunque tu shell defina otros para desarrollar).
        env.insert(
            "CONTROL_PLANE_WEB_DIST".into(),
            bundle.join("web").to_string_lossy().into_owned(),
        );
        env.insert(
            "CONTROL_PLANE_COMPACT_HOOK".into(),
            bundle
                .join("compact-hook.mjs")
                .to_string_lossy()
                .into_owned(),
        );

        let log_path = server_log::log_path(&self.dirs().1, port);
        let (log, offset) = match server_log::open_for_run(&log_path) {
            Ok(x) => x,
            Err(e) => {
                return self.show(Screen::failed(&format!(
                    "No pude abrir el log {}: {e}",
                    log_path.display()
                )))
            }
        };
        *self.state().log.lock().expect("sidecar") = Some(log_path.clone());
        let child = match spawn(&node, &[entry.as_os_str()], &env, log, user_home.as_deref()) {
            Ok(c) => c,
            Err(e) => {
                return self.show(Screen::failed(&format!(
                    "No pude ejecutar {}: {e}",
                    node.display()
                )))
            }
        };
        let pid = child.id();
        eprintln!("Lancé el server en el puerto {port} (pid {pid}).");
        let st = StateFile {
            pid,
            pgid: Some(pid),
            launch_id: launch_id.clone(),
            port,
            started_at: now_ms(),
            log_path,
            log_offset: offset,
        };
        if let Err(e) = st.write(&self.state_file(port)) {
            eprintln!("No pude guardar el estado del server: {e}");
        }
        self.phase = Phase::Starting {
            child,
            expected: Expected {
                pid,
                pgid: pid,
                launch_id,
            },
            since: Instant::now(),
            offset,
            slow: false,
        };
        self.show(Screen::starting(port));
    }

    // ------------------------------------------------------------------ supervisar

    fn on_tick(&mut self) {
        let Some(port) = self.port else { return };
        match std::mem::replace(&mut self.phase, Phase::Idle) {
            Phase::Idle => {}
            Phase::Starting {
                mut child,
                expected,
                since,
                offset,
                slow,
            } => {
                if let Ok(Some(status)) = child.try_wait() {
                    return self.start_failed(port, status.code(), offset);
                }
                if let Probe::ControlPlane(h) = health::probe(port) {
                    if h.launch_id.as_deref() == Some(expected.launch_id.as_str()) {
                        // El pid que vale es el del health: si `node` es un shim (Volta), el
                        // server es un hijo suyo. El grupo sigue siendo el del proceso lanzado.
                        let expected = Expected {
                            pid: h.pid,
                            ..expected
                        };
                        self.record(port, &expected, offset);
                        self.phase = Phase::Own {
                            child: Some(child),
                            expected,
                            started_ms: h.started_at,
                            offset,
                            down_since: None,
                        };
                        return self.ready(port);
                    }
                }
                let slow_now = !slow && since.elapsed() >= SLOW_AFTER;
                if slow_now {
                    self.show(Screen::slow(port));
                }
                self.phase = Phase::Starting {
                    child,
                    expected,
                    since,
                    offset,
                    slow: slow || slow_now,
                };
            }
            Phase::Own {
                child: Some(mut child),
                expected,
                started_ms,
                offset,
                down_since,
            } => match child.try_wait() {
                Ok(Some(status)) => {
                    let code = status
                        .code()
                        .map(|c| format!("con código {c}"))
                        .unwrap_or_else(|| "por una señal".into());
                    self.own_crashed(port, &code, started_ms, offset);
                }
                _ => {
                    self.phase = Phase::Own {
                        child: Some(child),
                        expected,
                        started_ms,
                        offset,
                        down_since,
                    }
                }
            },
            Phase::Own {
                child: None,
                expected,
                started_ms,
                offset,
                down_since,
            } => {
                let probe = health::probe(port);
                let same = matches!(&probe, Probe::ControlPlane(h)
                    if h.pid == expected.pid && h.launch_id.as_deref() == Some(expected.launch_id.as_str()));
                if same {
                    self.phase = Phase::Own {
                        child: None,
                        expected,
                        started_ms,
                        offset,
                        down_since: None,
                    };
                    return;
                }
                if matches!(probe, Probe::ControlPlane(_)) {
                    // Hay otro server en el puerto: el nuestro ya no está.
                    self.lost();
                    return self.discover(port);
                }
                let since = down_since.unwrap_or_else(Instant::now);
                if since.elapsed() >= FOREIGN_GRACE {
                    if !pid_alive(expected.pid) {
                        return self.own_crashed(port, "sin avisar", started_ms, offset);
                    }
                    // Vivo pero sin responder: no se lo toca (no se puede verificar).
                    self.lost();
                    return self.show(Screen::not_responding(port, expected.pid));
                }
                self.phase = Phase::Own {
                    child: None,
                    expected,
                    started_ms,
                    offset,
                    down_since: Some(since),
                };
            }
            Phase::Foreign { pid, down_since } => {
                match health::probe(port) {
                    Probe::ControlPlane(h) if Some(h.pid) == pid => {
                        self.phase = Phase::Foreign {
                            pid,
                            down_since: None,
                        };
                    }
                    Probe::ControlPlane(_) => {
                        // Lo reemplazaron (p. ej. reiniciaron `npm start`): mirar de nuevo.
                        self.lost();
                        self.discover(port);
                    }
                    _ => {
                        let since = down_since.unwrap_or_else(Instant::now);
                        if since.elapsed() >= FOREIGN_GRACE {
                            self.lost();
                            (self.hooks.notify)(
                                &self.app,
                                "El server se detuvo",
                                "No lo había lanzado la app, así que no lo relanzo sola.",
                            );
                            self.show(Screen::foreign_gone(port));
                        } else {
                            self.phase = Phase::Foreign {
                                pid,
                                down_since: Some(since),
                            };
                        }
                    }
                }
            }
        }
    }

    fn log_tail(&self, offset: u64) -> Vec<String> {
        self.state()
            .log_path()
            .map(|p| server_log::tail_from(&p, offset, server_log::TAIL_LINES))
            .unwrap_or_default()
    }

    /// El server que se estaba lanzando terminó antes de estar listo.
    fn start_failed(&mut self, port: u16, code: Option<i32>, offset: u64) {
        StateFile::remove(&self.state_file(port));
        let tail = self.log_tail(offset);
        self.phase = Phase::Idle;
        if server_state::is_lock_error(&tail) {
            let lock = self.home.as_deref().and_then(server_state::read_lock);
            if let Some(l) = lock {
                self.lock_port = Some(l.port);
                return self.show(Screen::locked(l.port, l.pid, tail));
            }
        }
        if server_state::is_claude_error(&tail) {
            return self.show(Screen::crashed_claude(tail));
        }
        let code = code
            .map(|c| format!("con código {c}"))
            .unwrap_or_else(|| "por una señal".into());
        self.show(Screen::crashed(&code, tail));
    }

    /// El server propio se cayó con la app abierta: siempre se avisa; a veces se relanza.
    fn own_crashed(&mut self, port: u16, code: &str, started_ms: u64, offset: u64) {
        StateFile::remove(&self.state_file(port));
        self.lost();
        self.phase = Phase::Idle;
        let uptime = Duration::from_millis(now_ms().saturating_sub(started_ms));
        let tail = self.log_tail(offset);
        eprintln!(
            "El server del puerto {port} se cerró {code} (vivió {} s).",
            uptime.as_secs()
        );
        match self.restarts.decide(uptime, Instant::now()) {
            Restart::Relaunch => {
                (self.hooks.notify)(
                    &self.app,
                    "El server se cerró",
                    &format!("Terminó {code}. Lo vuelvo a lanzar."),
                );
                self.show(Screen::restarting());
                self.discover(port);
            }
            Restart::TooSoon => {
                (self.hooks.notify)(
                    &self.app,
                    "El server se cerró",
                    &format!("Terminó {code} al poco de arrancar. Mirá el log en la app."),
                );
                self.show(Screen::crashed(code, tail));
            }
            Restart::TooMany => {
                (self.hooks.notify)(
                    &self.app,
                    "El server se sigue cayendo",
                    "Lo relancé 3 veces en 5 minutos. No lo vuelvo a lanzar solo.",
                );
                self.show(Screen::too_many_restarts(tail));
            }
        }
    }

    // ------------------------------------------------------------------ botones

    fn busy(&self) -> Busy {
        match &self.phase {
            Phase::Idle => Busy::Idle,
            Phase::Starting { .. } => Busy::Starting,
            Phase::Own { .. } | Phase::Foreign { .. } => Busy::Running,
        }
    }

    /// Guarda en el archivo de estado el pid que confirmó el health.
    fn record(&self, port: u16, e: &Expected, offset: u64) {
        let path = self.state_file(port);
        if let Some(mut st) = StateFile::read(&path) {
            st.pid = e.pid;
            st.pgid = Some(e.pgid);
            st.log_offset = offset;
            if let Err(err) = st.write(&path) {
                eprintln!("No pude guardar el estado del server: {err}");
            }
        }
    }

    fn on_action(&mut self, req: Request) {
        if !policy::action_allowed(self.busy(), req.action) {
            eprintln!("Ignoro \"{}\": no corresponde ahora.", req.action.id());
            return;
        }
        let port = self.port;
        match req.action {
            Action::Retry => self.boot(),
            Action::Launch => match port {
                Some(p) => self.discover(p),
                None => self.boot(),
            },
            Action::PickNode => self.pick_node(),
            Action::GetNode => window::open_in_browser(NODEJS_URL),
            Action::OpenAnyway => {
                if let Some(p) = port {
                    // Un server viejo sin health: no hay cómo supervisarlo, solo se lo muestra.
                    self.phase = Phase::Idle;
                    self.ready(p);
                }
            }
            Action::Cancel => {
                if let Some(p) = port {
                    self.show(Screen::old_server_waiting(p));
                }
            }
            Action::SetPort => match req.port {
                Some(p) => match window::resolve_port(
                    Some(&p.to_string()),
                    None,
                    None,
                    cfg!(debug_assertions),
                    std::env::var("CONTROL_PLANE_ALLOW_4700").is_ok_and(|v| v == "1"),
                ) {
                    Ok(p) => {
                        self.port_override = Some(p);
                        self.save_settings(|s| s.port = Some(p));
                        self.port = Some(p);
                        self.discover(p);
                    }
                    Err(e) => self.show(Screen::bad_port(&e.to_string())),
                },
                None => self.show(Screen::bad_port("Escribí un número de puerto.")),
            },
            Action::UseThat => {
                if let Some(p) = self.lock_port {
                    // Con las mismas reglas que cualquier puerto (en desarrollo, nunca el 4700).
                    match window::resolve_port(
                        Some(&p.to_string()),
                        None,
                        None,
                        cfg!(debug_assertions),
                        std::env::var("CONTROL_PLANE_ALLOW_4700").is_ok_and(|v| v == "1"),
                    ) {
                        Ok(p) => {
                            self.port_override = Some(p);
                            self.port = Some(p);
                            self.discover(p);
                        }
                        Err(e) => self.show(Screen::bad_port(&e.to_string())),
                    }
                }
            }
            Action::Wait => {
                if let (Phase::Starting { .. }, Some(p)) = (&self.phase, port) {
                    self.show(Screen::starting(p));
                }
            }
            Action::ShowLog => open_log(&self.app),
            Action::Stop => {
                if self.stop_own() {
                    self.show(Screen::crashed("porque lo detuviste", Vec::new()));
                }
            }
        }
    }

    fn pick_node(&mut self) {
        let picked = self
            .app
            .dialog()
            .file()
            .set_title("Elegí el ejecutable de Node 24")
            .blocking_pick_file();
        if let Some(path) = picked.and_then(|p| p.into_path().ok()) {
            self.save_settings(|s| s.node_path = Some(path));
            self.boot();
        }
    }

    // ------------------------------------------------------------------ detener y salir

    fn kind(&self) -> ServerKind {
        match &self.phase {
            Phase::Starting { .. } | Phase::Own { .. } => ServerKind::Own,
            Phase::Foreign { .. } => ServerKind::Foreign,
            // Un server viejo abierto igual (Idle con guarda) no es de la app.
            Phase::Idle => ServerKind::None,
        }
    }

    fn on_exit(&mut self) {
        let on_exit = self.settings().on_exit;
        let ending = self.state().system_ending.load(Ordering::SeqCst);
        let mut action = policy::exit_action(self.kind(), on_exit, None, ending);
        if action == ExitAction::Ask {
            let answer = self.ask_exit();
            action = policy::exit_action(self.kind(), on_exit, Some(answer), ending);
        }
        match action {
            ExitAction::Stay | ExitAction::Ask => {}
            ExitAction::Exit => self.exit_now(),
            ExitAction::StopThenExit => {
                window::show_main(&self.app);
                self.show(Screen::stopping());
                if !self.stop_own() {
                    let port = self.port.unwrap_or(0);
                    self.app
                        .dialog()
                        .message(format!(
                            "No pude confirmar que el server del puerto {port} sea el que lanzó la app, así que no le mandé nada. Si querés detenerlo, hacelo a mano."
                        ))
                        .title("control-plane")
                        .kind(MessageDialogKind::Warning)
                        .blocking_show();
                }
                self.exit_now();
            }
        }
    }

    fn ask_exit(&self) -> Answer {
        let running = (self.hooks.running)(&self.app);
        let (stop, leave, cancel) = ("Detener y salir", "Dejarlo corriendo", "Cancelar");
        let result = self
            .app
            .dialog()
            .message(policy::exit_question(running))
            .title("Salir de control-plane")
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::YesNoCancelCustom(
                stop.into(),
                leave.into(),
                cancel.into(),
            ))
            .blocking_show_with_result();
        match result {
            MessageDialogResult::Yes => Answer::Stop,
            MessageDialogResult::No => Answer::Leave,
            MessageDialogResult::Custom(s) if s == stop => Answer::Stop,
            MessageDialogResult::Custom(s) if s == leave => Answer::Leave,
            _ => Answer::Cancel,
        }
    }

    fn exit_now(&self) {
        self.state().exit_ok.store(true, Ordering::SeqCst);
        self.app.exit(0);
    }

    /// Detiene el server propio: verifica, SIGTERM (el apagado ordenado del server), espera
    /// hasta 15 s y, si sigue, SIGKILL a su grupo. Devuelve false si no se pudo verificar.
    fn stop_own(&mut self) -> bool {
        let Some(port) = self.port else { return true };
        let (mut child, expected) = match std::mem::replace(&mut self.phase, Phase::Idle) {
            Phase::Starting {
                child, expected, ..
            } => (Some(child), expected),
            Phase::Own {
                child, expected, ..
            } => (child, expected),
            other => {
                self.phase = other;
                return true;
            }
        };
        let child_pid = child.as_ref().map(Child::id);
        // El pidfd se abre antes del health que lo verifica.
        let target = Target::open(expected.pid);
        let fresh = match health::probe(port) {
            Probe::ControlPlane(h) => Some(h),
            _ => None,
        };
        let health_ok = server_state::may_signal(&expected, fresh.as_ref(), false);
        let child_ok = child_alive(&mut child);
        if !health_ok && !child_ok {
            if child.is_none() && !pid_alive(expected.pid) {
                // Ya no estaba.
                StateFile::remove(&self.state_file(port));
                self.lost();
                return true;
            }
            eprintln!("No pude verificar el server del puerto {port}: no le mando señales.");
            self.lost();
            return false;
        }
        self.lost();
        eprintln!(
            "Deteniendo el server del puerto {port} (pid {}).",
            expected.pid
        );
        match (health_ok, child_pid) {
            (true, _) => target.signal(libc::SIGTERM),
            (false, Some(pid)) => signal_child(pid, libc::SIGTERM),
            (false, None) => unreachable!("sin health ni hijo no se llega acá"),
        }
        let gone = wait_gone(&mut child, expected.pid, STOP_GRACE);
        // El SIGKILL al grupo solo con el líder sin cosechar o un health nuevo que coincida.
        if !gone && (child_alive(&mut child) || health_matches(&expected, port)) {
            eprintln!(
                "No terminó en {} s: SIGKILL al grupo.",
                STOP_GRACE.as_secs()
            );
            signal_group(expected.pgid, libc::SIGKILL);
            if child.is_none() {
                target.signal(libc::SIGKILL);
            }
            wait_gone(&mut child, expected.pid, Duration::from_secs(2));
        }
        StateFile::remove(&self.state_file(port));
        true
    }
}

fn child_alive(c: &mut Option<Child>) -> bool {
    c.as_mut().is_some_and(|c| matches!(c.try_wait(), Ok(None)))
}

fn health_matches(expected: &Expected, port: u16) -> bool {
    match health::probe(port) {
        Probe::ControlPlane(h) => server_state::may_signal(expected, Some(&h), false),
        _ => false,
    }
}

/// Espera a que el proceso termine (lo cosecha si es hijo).
fn wait_gone(child: &mut Option<Child>, pid: u32, max: Duration) -> bool {
    let until = Instant::now() + max;
    while Instant::now() < until {
        let gone = match child {
            Some(c) => !matches!(c.try_wait(), Ok(None)),
            None => !pid_alive(pid),
        };
        if gone {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

fn spawn(
    program: &Path,
    args: &[&std::ffi::OsStr],
    env: &BTreeMap<String, String>,
    log: File,
    cwd: Option<&Path>,
) -> std::io::Result<Child> {
    let err = log.try_clone()?;
    let mut cmd = Command::new(program);
    cmd.args(args)
        .env_clear()
        .envs(env)
        .current_dir(cwd.filter(|d| d.is_dir()).unwrap_or(Path::new("/")))
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err));
    // SAFETY: entre fork y exec solo setsid y fcntl, que son async-signal-safe.
    unsafe {
        cmd.pre_exec(|| {
            // Sesión y grupo propios, sin terminal: cerrar la app no le manda nada.
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            cloexec_all();
            Ok(())
        });
    }
    cmd.spawn()
}

/// Para el health de "¿es el mismo?" fuera del hilo (tests y T4).
pub fn same_server(h: &Health, expected: &Expected) -> bool {
    server_state::may_signal(expected, Some(h), false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_home_is_never_the_real_one() {
        let home = Path::new("/home/u");
        let tmp = Path::new("/tmp");
        assert_eq!(
            resolve_home(None, Some(home), tmp, 4711, true, false),
            Ok(Some(PathBuf::from("/tmp/control-plane-dev-4711")))
        );
        assert_eq!(
            resolve_home(Some("  "), Some(home), tmp, 4711, true, false),
            Ok(Some(PathBuf::from("/tmp/control-plane-dev-4711")))
        );
        assert!(resolve_home(
            Some("/home/u/.control-plane"),
            Some(home),
            tmp,
            4711,
            true,
            false
        )
        .is_err());
        assert!(resolve_home(
            Some("/home/u/.control-plane/"),
            Some(home),
            tmp,
            4711,
            true,
            false
        )
        .is_err());
        assert_eq!(
            resolve_home(
                Some("/home/u/.control-plane"),
                Some(home),
                tmp,
                4711,
                true,
                true
            ),
            Ok(Some(PathBuf::from("/home/u/.control-plane")))
        );
        assert_eq!(
            resolve_home(Some("/data/cp"), Some(home), tmp, 4711, true, false),
            Ok(Some(PathBuf::from("/data/cp")))
        );
        // En release manda lo que venga (y si no viene, el default del server).
        assert_eq!(
            resolve_home(None, Some(home), tmp, 4700, false, false),
            Ok(None)
        );
    }

    #[test]
    fn spawned_server_is_in_its_own_session_without_tty_and_clean_env() {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("server.log");
        let (log, _) = server_log::open_for_run(&log_path).unwrap();
        let env: BTreeMap<String, String> =
            [("PATH".to_string(), "/usr/bin:/bin".to_string())].into();
        std::env::set_var("CP_TEST_NO_DEBE_LLEGAR", "1");
        let script = "echo pid=$$; echo sid=$(ps -o sid= -p $$ | tr -d ' '); [ -t 0 ] && echo tty || echo sin-tty; echo var=$CP_TEST_NO_DEBE_LLEGAR";
        let mut child = spawn(
            Path::new("/bin/sh"),
            &["-c".as_ref(), script.as_ref()],
            &env,
            log,
            None,
        )
        .unwrap();
        child.wait().unwrap();
        let text = std::fs::read_to_string(&log_path).unwrap();
        let field = |k: &str| {
            text.lines()
                .find_map(|l| l.strip_prefix(&format!("{k}=")))
                .unwrap_or("?")
                .to_string()
        };
        // Líder de su propia sesión: cerrar la app (o su terminal) no le manda nada.
        assert_eq!(field("pid"), field("sid"), "{text}");
        assert!(text.contains("sin-tty"), "{text}");
        // env_clear: solo llega lo que se le pasa.
        assert_eq!(field("var"), "", "{text}");
    }
}
