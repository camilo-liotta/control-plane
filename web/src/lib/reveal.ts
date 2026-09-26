/** Lleva la vista hasta un elemento y lo marca un momento (al llegar desde un aviso). */
export function reveal(el: HTMLElement) {
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  el.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" })
  el.classList.remove("reveal-flash")
  void el.offsetWidth
  el.classList.add("reveal-flash")
  window.setTimeout(() => el.classList.remove("reveal-flash"), 1900)
}
