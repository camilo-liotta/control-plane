import { createCn } from "cn/config"

/**
 * clsx + tailwind-merge, con los tokens propios de index.css: si no, `text-ui` se toma por un color
 * y se come al `text-primary-foreground` de al lado (y `shadow-raised`, a la sombra).
 */
export const cn = createCn({
  extend: {
    classGroups: {
      "font-size": [{ text: ["2xs", "ui"] }],
      shadow: [{ shadow: ["raised", "overlay", "sheet"] }],
    },
  },
})
