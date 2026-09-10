import { Command, CommanderError } from "commander";
import { runCall } from "./commands/call.js";
import { runConnect } from "./commands/connect.js";
import { runDisconnect } from "./commands/disconnect.js";
import { runDoctor } from "./commands/doctor.js";
import { defaultInitName, runInit } from "./commands/init.js";
import { runList } from "./commands/list.js";
import { runMcp } from "./commands/mcp.js";
import { runServices } from "./commands/services.js";
import { runStatus } from "./commands/status.js";
import { runWhoami } from "./commands/whoami.js";
import type { Flags, Io } from "./io.js";
import { UsageError } from "./io.js";
import { type Outcome, present, writeErr, writeOut } from "./output.js";
import { resolveHome, resolveProfile } from "./profile.js";
import { asOutcome } from "./util.js";
import { VERSION } from "./version.js";

function globals(cmd: Command): Command {
  return cmd
    .option("--profile <name>", "profile name")
    .option("--json", "JSON output")
    .option("--quiet", "suppress informational lines")
    .option("--home <dir>", "override HORS_HOME");
}

function flagsOf(cmd: Command, io: Io): Flags {
  const opts = cmd.optsWithGlobals() as {
    profile?: string;
    json?: boolean;
    quiet?: boolean;
    home?: string;
  };
  return {
    profile: resolveProfile(io, opts.profile),
    json: opts.json === true,
    quiet: opts.quiet === true,
    home: resolveHome(io, opts.home),
    ...(opts.home !== undefined && opts.home !== "" ? { homeFlag: opts.home } : {}),
  };
}

function preview(argv: readonly string[]): Pick<Flags, "json" | "quiet"> {
  return { json: argv.includes("--json"), quiet: argv.includes("--quiet") };
}

export async function run(argv: readonly string[], io: Io): Promise<number> {
  const flagsPreview = preview(argv);
  try {
    return await execute(argv, io);
  } catch (error) {
    return present(
      io,
      { ...flagsPreview, profile: "default", home: resolveHome(io, undefined) },
      asOutcome(error),
    );
  }
}

async function execute(argv: readonly string[], io: Io): Promise<number> {
  let exit = 0;
  const program = globals(new Command());
  program
    .name("hors")
    .description("HORS CLI and MCP bridge")
    .version(VERSION, "--version")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => writeOut(io, text),
      writeErr: (text) => writeErr(io, text),
    })
    .action(() => {
      writeErr(io, program.helpInformation());
      exit = 2;
    });

  const runCommand =
    <A extends unknown[]>(work: (flags: Flags, ...args: A) => Promise<Outcome>) =>
    async (...args: A) => {
      const flags = flagsOf(program, io);
      try {
        exit = present(io, flags, await work(flags, ...args));
      } catch (error) {
        exit = present(io, flags, asOutcome(error));
      }
    };

  const profileFromCli = () =>
    argv.some((arg) => arg === "--profile" || arg.startsWith("--profile="));

  globals(program.command("status").description("Show profile and live registration")).action(
    runCommand((flags) => runStatus(io, flags)),
  );
  globals(program.command("whoami").description("Print the pinned humanId")).action(
    runCommand((flags) => runWhoami(io, flags)),
  );
  globals(program.command("doctor").description("Check the local HORS setup")).action(
    runCommand((flags) => runDoctor(io, flags)),
  );
  globals(program.command("mcp").description("Run the MCP bridge on stdio")).action(
    runCommand((flags) => runMcp(io, flags)),
  );
  globals(
    program
      .command("init")
      .description("Write a starter hors.config.ts")
      .option("--force", "overwrite an existing hors.config.ts"),
  ).action(
    runCommand(async (flags, opts: { force?: boolean }) => {
      const name = profileFromCli() ? flags.profile : await defaultInitName(io);
      return runInit(io, flags, { force: opts.force, name });
    }),
  );
  globals(
    program
      .command("connect")
      .description("Create the profile and pin a World ID")
      .option("--label <text>", "profile label")
      .option("--no-register", "only create the profile"),
  ).action(
    runCommand((flags, opts: { label?: string; register?: boolean }) =>
      runConnect(io, flags, { label: opts.label, noRegister: opts.register === false }),
    ),
  );
  globals(
    program
      .command("disconnect")
      .description("Delete the profile directory")
      .option("--yes", "skip confirmation"),
  ).action(runCommand((flags, opts: { yes?: boolean }) => runDisconnect(io, flags, opts)));
  globals(program.command("list").description("List remote tools").argument("<service>")).action(
    runCommand((flags, service: string) => runList(io, flags, service)),
  );
  globals(
    program
      .command("call")
      .description("Sign and call a remote function")
      .argument("<service>")
      .argument("<fn>")
      .argument("[json]")
      .option("--meta <json>", "hors/meta JSON object"),
  ).action(
    runCommand(
      (flags, service: string, fn: string, json: string | undefined, opts: { meta?: string }) =>
        runCall(io, flags, service, fn, json, opts.meta),
    ),
  );

  const services = globals(
    program.command("services").description("Show or edit the address book"),
  );
  services.action(runCommand((flags) => runServices(io, flags)));
  globals(services.command("add").argument("<name>").argument("<uri>")).action(
    runCommand((flags, name: string, uri: string) =>
      runServices(io, flags, { op: "add", name, uri }),
    ),
  );
  globals(services.command("rm").argument("<name>")).action(
    runCommand((flags, name: string) => runServices(io, flags, { op: "rm", name })),
  );

  try {
    await program.parseAsync([...argv], { from: "user" });
    return exit;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
        return 0;
      }
      return 2;
    }
    if (error instanceof UsageError) {
      return present(
        io,
        { ...preview(argv), profile: "default", home: resolveHome(io, undefined) },
        asOutcome(error),
      );
    }
    throw error;
  }
}
