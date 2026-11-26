import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

/** The program's own notice: the first lines of every distributed file. */
function programNotice(version: string): string[] {
  return [
    `OtzariaLinker ${version} — https://github.com/Otzaria/OtzariaLinker`,
    "Copyright (C) the OtzariaLinker contributors.",
    "This program is free software: you can redistribute it and/or modify it under the terms of the",
    "GNU General Public License as published by the Free Software Foundation, either version 3 of the",
    "License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY.",
    "See <https://www.gnu.org/licenses/>. Source code: the repository above, at the tag of this version.",
  ];
}

/** A bundled package's version and LICENSE file, as one block. */
function licenceOf(pkg: string): string {
  // package.json is not always in a package's "exports", so locate the folder directly.
  const dir = join(process.cwd(), "node_modules", pkg);
  const file = readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
  if (!file) throw new Error(`license-notice: no LICENSE file in ${pkg}`);
  const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string };
  return `----- ${pkg}@${version} -----\n${readFileSync(join(dir, file), "utf8").trim()}`;
}

/**
 * The distributed HTML is the whole program, so it must carry its own licence and the notices of
 * every bundled third-party package (MIT requires the notice to travel with copies). They go into
 * one HTML comment at the top of the file.
 */
export function licenseNotice(opts: { packages: readonly string[]; version: string }): Plugin {
  return {
    name: "otzaria-linker:license-notice",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const header = [
          ...programNotice(opts.version),
          "",
          "Bundled third-party software:",
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

/** The package a bundled module comes from: a node_modules path, or the package path of a `virtual:wasm-b64/` id. */
function packageOf(id: string): string | undefined {
  const m = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(id) ?? /virtual:wasm-b64\/((?:@[^/]+\/)?[^/]+)\//.exec(id);
  return m?.[1]?.replace(/\\/g, "/");
}

/**
 * The same notice for a JavaScript bundle (dist-cli/linker.mjs, dist-plugin/otzaria-linker-core.js; V7 PR4 review): the
 * program's notice and the notice of every package whose modules went into the chunk. The list is read from the chunk
 * itself, not written by hand, so a package that comes in transitively is not missed. One `/*!` comment at the top (after a
 * hashbang, if any), added after minification so it is kept.
 */
export function licenseBanner(opts: { version: string }): Plugin {
  return {
    name: "otzaria-linker:license-banner",
    apply: "build",
    generateBundle(_, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        const packages = [...new Set(chunk.moduleIds.map(packageOf).filter((p): p is string => !!p))].sort();
        const lines = [...programNotice(opts.version), "", packages.length ? "Bundled third-party software:" : "No third-party package is bundled."];
        // "*/" would close the comment early.
        const body = [lines.join("\n"), ...packages.map(licenceOf)].join("\n\n").replace(/\*\//g, "* /");
        const comment = `/*!\n${body}\n*/\n`;
        const bang = chunk.code.startsWith("#!") ? chunk.code.indexOf("\n") + 1 : 0;
        chunk.code = chunk.code.slice(0, bang) + comment + chunk.code.slice(bang);
      }
    },
  };
}
