import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { checkOutfitAnimation, compareAnimations, type AnimationGroup } from "../src/formats/animation-check.js";
import type { DatRecordView } from "../src/formats/dat.js";
import { buildObdPayload, compressObd, validateObdPayload } from "../src/formats/obd.js";
import { AssetProject } from "../src/project/project.js";

/** Opaque 32×32 sprite unique to `id`. */
function pixels(id: number): Buffer | undefined {
  if (id === 0) return undefined;
  const rgba = Buffer.alloc(32 * 32 * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([id & 0xff, id >> 8, 9, 255], offset);
  return rgba;
}

/** Idle (1 frame) + walking (8 frames) outfit, 4 directions, 1×1 tiles, 1 layer; every slot a distinct sprite. */
function groups(): AnimationGroup[] {
  let next = 1;
  const group = (frames: number): AnimationGroup => ({
    width: 1, height: 1, layers: 1, patternX: 4, patternY: 1, patternZ: 1, frames,
    spriteIds: Array.from({ length: 4 * frames }, () => next++),
    ...(frames > 1 ? { durations: Array.from({ length: frames }, () => [100, 120] as const) } : {}),
  });
  return [group(1), group(8)];
}

test("confirms a complete idle + walking outfit without warnings", () => {
  const report = checkOutfitAnimation("outfits 1", groups(), pixels);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.summary, "2 grupos · 4 direções · andando 8 frames");
});

test("reports outfits whose movement is missing, empty or broken", () => {
  const still = groups();
  // Walking south (x = 2) shows the same sprite in every frame: no movement in that direction.
  still[1] = { ...still[1]!, spriteIds: still[1]!.spriteIds.map((id, slot) => (slot % 4 === 2 ? 999 : id)) };
  assert.match(checkOutfitAnimation("o", still, pixels).warnings.join(), /todos os frames são iguais em sul \(não há movimento\)/);

  const hole = groups();
  hole[1] = { ...hole[1]!, spriteIds: hole[1]!.spriteIds.map((id, slot) => (slot === 4 * 3 + 1 ? 0 : id)) };
  assert.match(checkOutfitAnimation("o", hole, pixels).warnings.join(), /frames sem nenhum pixel: leste frame 4/);

  const single = [groups()[0]!];
  assert.match(checkOutfitAnimation("o", single, pixels).warnings.join(), /tem 1 frame; o outfit não terá animação de movimento/);

  const empty = groups().map((group) => ({ ...group, spriteIds: group.spriteIds.map(() => 0) }));
  assert.deepEqual(checkOutfitAnimation("o", empty, pixels).warnings, ["o: o outfit não tem nenhum pixel (vazio ou invisível)."]);

  const badDurations = groups();
  badDurations[1] = { ...badDurations[1]!, durations: [[300, 100], ...badDurations[1]!.durations!.slice(1)] };
  assert.match(checkOutfitAnimation("o", badDurations, pixels).errors.join(), /frame 1 tem duração mínima 300 maior que a máxima 100/);

  const short = groups();
  short[1] = { ...short[1]!, spriteIds: short[1]!.spriteIds.slice(1) };
  assert.match(checkOutfitAnimation("o", short, pixels).errors.join(), /31 sprites, mas o layout exige 32/);
});

test("detects lost groups, swapped frames or directions, and changed durations", () => {
  const source = { groups: groups(), pixels };
  assert.deepEqual(compareAnimations("o", source, source), []);
  assert.match(compareAnimations("o", source, { groups: [groups()[0]!], pixels }).join(), /1 grupo\(s\) de frames em vez de 2/);

  const swapped = groups();
  const ids = [...swapped[1]!.spriteIds];
  [ids[4 * 5 + 0], ids[4 * 5 + 2]] = [ids[4 * 5 + 2]!, ids[4 * 5 + 0]!]; // north and south of frame 6 swapped
  swapped[1] = { ...swapped[1]!, spriteIds: ids };
  assert.match(compareAnimations("o", source, { groups: swapped, pixels }).join(), /\(grupo 2\): 2 sprite\(s\) diferentes da origem \(frames 6\)/);

  const slower = groups();
  slower[1] = { ...slower[1]!, durations: slower[1]!.durations!.map((duration, frame) => (frame === 3 ? [100, 999] as const : duration)) };
  assert.match(compareAnimations("o", source, { groups: slower, pixels }).join(), /a duração do frame 4 mudou/);

  // Without SPR transparency, partially transparent pixels come back opaque: that is not a loss.
  const translucent = (id: number) => { const rgba = pixels(id)!; rgba[3] = 128; return rgba; };
  assert.deepEqual(compareAnimations("o", { groups: groups(), pixels: translucent }, source, false), []);
  assert.notDeepEqual(compareAnimations("o", { groups: groups(), pixels: translucent }, source, true), []);
});

function outfitRecord(): DatRecordView {
  return {
    id: 5, category: "outfits", flags: [], properties: {},
    groups: groups().map((group, index) => {
      const animationData = Buffer.alloc(group.frames > 1 ? 6 + group.frames * 8 : 0);
      group.durations?.forEach(([minimum, maximum], frame) => {
        animationData.writeUInt32LE(minimum, 6 + frame * 8);
        animationData.writeUInt32LE(maximum, 10 + frame * 8);
      });
      return { ...group, type: index, exactSize: 32, animationData };
    }),
  };
}

test("an export is checked against its source and a corrupted payload is caught", () => {
  const input = { record: outfitRecord(), clientVersion: 1098, spriteSize: 32, getSprite: pixels };
  const payload = buildObdPayload(input);
  const ok = validateObdPayload(input, payload);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.summary, "2 grupos · 4 direções · andando 8 frames");

  // Flip one pixel of the last sprite (walking, west, frame 8) as a faulty encoder would.
  const raw = Buffer.from(payload.raw);
  raw[raw.length - 10]! ^= 0xff;
  assert.match(validateObdPayload(input, { ...payload, raw }).errors.join(), /\(grupo 2\): 1 sprite\(s\) diferentes da origem \(frames 8\)/);
});

test("import reports the validated animation and rejects broken movement without leaving sprites behind", () => {
  const file = compressObd(buildObdPayload({ record: outfitRecord(), clientVersion: 1098, spriteSize: 32, getSprite: pixels }).raw);
  const project = AssetProject.create(1, { clientVersion: 1098 });
  const result = project.importObd(file);
  assert.equal(result.validation, "2 grupos · 4 direções · andando 8 frames");
  assert.deepEqual(result.warnings, []);

  const broken = outfitRecord();
  const walking = broken.groups[1]!;
  walking.animationData.writeUInt32LE(900, 6); // frame 1: minimum 900 > maximum 120
  const brokenFile = compressObd(buildObdPayload({ record: broken, clientVersion: 1098, spriteSize: 32, getSprite: pixels }).raw);
  const outfits = project.summary.counts.outfits;
  const sprites = project.summary.sprites.spriteCount;
  assert.throws(() => project.importObd(brokenFile), /animação inválida: .*duração mínima 900 maior que a máxima 120/);
  assert.equal(project.summary.counts.outfits, outfits, "no record is left behind");
  assert.equal(project.summary.sprites.spriteCount, sprites, "no sprite is left behind");
  assert.throws(() => project.replaceWithObd("outfits", result.id, brokenFile), /animação inválida/);
  assert.equal(project.summary.sprites.spriteCount, sprites);
});
