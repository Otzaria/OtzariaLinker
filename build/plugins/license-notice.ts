import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

/**
 * The distributed HTML is the whole program, so it must carry its own licence and the notices of
 * every bundled third-party package (MIT requires the notice to travel with copies). They go into
 * one HTML comment at the top of the file.
 */
export function licenseNotice(opts: { packages: readonly string[]; version: string }): Plugin {
  const licenceOf = (pkg: string): string => {
    // package.json is not always in a package's "exports", so locate the folder directly.
    const dir = join(process.cwd(), "node_modules", pkg);
    const file = readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
    if (!file) throw new Error(`license-notice: no LICENSE file in ${pkg}`);
    const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string };
    return `----- ${pkg}@${version} -----\n${readFileSync(join(dir, file), "utf8").trim()}`;
  };
  return {
    name: "otzaria-linker:license-notice",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const header = [
          `OtzariaLinker ${opts.version} — https://github.com/Otzaria/OtzariaLinker`,
          "Copyright (C) the OtzariaLinker contributors.",
          "This program is free software: you can redistribute it and/or modify it under the terms of the",
          "GNU General Public License as published by the Free Software Foundation, either version 3 of the",
          "License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY.",
          "See <https://www.gnu.org/licenses/>. Source code: the repository above, at the tag of this version.",
          "",
          "Bundled third-party software:",
          "SQLite (inside sql.js) is in the public domain.",
          "Otzaria Icons (github.com/Otzaria/otzaria_icons) — GPL-3.0.",
          "Fluent UI System Icons (github.com/microsoft/fluentui-system-icons), a few generic icons — MIT,",
          "  Copyright (c) 2020 Microsoft Corporation.",
          "Frank Ruehl CLM (Culmus project, Maxim Iorsh) — GPL-2.0 with the font exception: embedding the font",
          "  in a document does not by itself make the document GPL.",
          "Noto Rashi Hebrew (Google) — SIL Open Font License 1.1.",
        ].join("\n");
        const notices = opts.packages.map(licenceOf).join("\n\n");
        // "--" may not appear inside an HTML comment.
        const body = `${header}\n\n${notices}`.replace(/-(?=-)/g, "- ");
        const comment = `<!--\n${body}\n-->`;
        return html.replace(/^(<!doctype html>)/i, `$1\n${comment}`);
      },
    },
  };
}
