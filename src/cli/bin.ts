import { main } from "./main";

/* The command's entry (dist-cli/linker.mjs, vite.cli.config.ts): arguments in, exit code out. */
main(process.argv.slice(2), { out: (t) => void process.stdout.write(t), err: (t) => void process.stderr.write(t) }).then(
  (code) => void (process.exitCode = code),
  (err: unknown) => {
    process.stderr.write(`${(err as Error)?.stack ?? String(err)}\n`);
    process.exitCode = 1;
  },
);
