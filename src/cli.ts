import { link, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { OtbDocument, OtbFormatError, type WritableField } from "./formats/otb.js";

const HELP = `OTEditor TypeScript CLI

Commands:
  inspect <input.otb>
  roundtrip <input.otb> <new-output.otb>
  set <input.otb> <new-output.otb> <server-id> <field> <value>

Writable fields: serverId, clientId, group, flags, name, description, speed,
minimapColor, maxReadWriteLength, maxReadLength, lightLevel, lightColor,
stackOrder, wareId.

Writes never overwrite an existing file or the input file.`;

const WRITABLE_FIELDS = new Set<WritableField>([
  "serverId",
  "clientId",
  "group",
  "flags",
  "name",
  "description",
  "speed",
  "minimapColor",
  "maxReadWriteLength",
  "maxReadLength",
  "lightLevel",
  "lightColor",
  "stackOrder",
  "wareId",
]);

async function readOtb(path: string): Promise<OtbDocument> {
  const info = await stat(path);
  if (!info.isFile()) {
    throw new Error(`Input is not a regular file: ${path}`);
  }
  return OtbDocument.parse(await readFile(path));
}

async function writeNewOutput(inputPath: string, outputPath: string, data: Buffer): Promise<void> {
  const input = await realpath(inputPath);
  const target = resolve(outputPath);
  if (input === target) {
    throw new Error("Output path must differ from input path");
  }
  try {
    const targetInfo = await stat(target);
    if (targetInfo.isFile() || targetInfo.isDirectory()) {
      throw new Error(`Refusing to overwrite existing output: ${target}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const parent = await realpath(dirname(target));
  const canonicalTarget = resolve(parent, basename(target));
  if (canonicalTarget === input) {
    throw new Error("Output path resolves to the input file");
  }

  const temporary = resolve(parent, `.${basename(target)}.${randomUUID()}.tmp`);
  let temporaryExists = false;
  try {
    const handle = await open(temporary, "wx");
    temporaryExists = true;
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, canonicalTarget);
    await unlink(temporary);
    temporaryExists = false;
  } finally {
    if (temporaryExists) {
      await unlink(temporary);
    }
  }
}

function parseInteger(value: string, name: string): number {
  if (!/^-?(0|[1-9]\d*)$/.test(value)) {
    throw new OtbFormatError(`${name} must be an integer`);
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new OtbFormatError(`${name} is outside the safe integer range`);
  }
  return result;
}

async function run(args: string[]): Promise<void> {
  const [command, ...values] = args;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }

  if (command === "inspect" && values.length === 1) {
    const document = await readOtb(values[0]!);
    console.log(JSON.stringify({
      format: "OTB",
      identifier: document.identifier.toString("latin1"),
      majorVersion: document.majorVersion ?? null,
      minorVersion: document.minorVersion ?? null,
      buildNumber: document.buildNumber ?? null,
      itemCount: document.itemCount,
      items: document.items.map((item) => ({
        group: item.group,
        flags: item.flags,
        serverId: item.serverId ?? null,
        clientId: item.clientId ?? null,
        name: item.name ?? null,
        attributeCount: item.attributes.length,
      })),
    }, null, 2));
    return;
  }

  if (command === "roundtrip" && values.length === 2) {
    const document = await readOtb(values[0]!);
    const output = document.serialize();
    await writeNewOutput(values[0]!, values[1]!, output);
    console.log(`Wrote ${output.length} bytes to ${values[1]}`);
    return;
  }

  if (command === "set" && values.length === 5) {
    const [input, output, serverIdText, fieldText, rawValue] = values as [string, string, string, string, string];
    if (!WRITABLE_FIELDS.has(fieldText as WritableField)) {
      throw new OtbFormatError(`Unsupported field "${fieldText}". Run "help" for writable fields.`);
    }
    const field = fieldText as WritableField;
    const document = await readOtb(input);
    const serverId = parseInteger(serverIdText, "server ID");
    const value = field === "name" || field === "description"
      ? rawValue
      : parseInteger(rawValue, field);
    document.setItemField(serverId, field, value);
    const outputData = document.serialize();
    await writeNewOutput(input, output, outputData);
    console.log(`Wrote edited OTB (${outputData.length} bytes) to ${output}`);
    return;
  }

  throw new Error(`Invalid command or arguments.\n\n${HELP}`);
}

run(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`oteditor-ts: ${message}`);
  process.exitCode = 1;
});
