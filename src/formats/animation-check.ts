import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

/**
 * Checks that an object's animation survives an OBD export or import, and that an outfit's movement makes sense.
 *
 * - `checkOutfitAnimation` looks at one object's frame groups the way the client draws them: idle and walking
 *   groups, the four directions, every walking frame of every direction having pixels, the frames actually
 *   changing (otherwise there is no visible movement) and the frame durations being usable. Findings are warnings:
 *   unusual outfits exist (e.g. one direction only) and the file is still valid.
 * - `compareAnimations` compares two versions of the same object slot by slot (layout, durations and pixels). Any
 *   difference is an error: it means a frame, direction or sprite was lost or swapped on the way.
 */

export interface AnimationGroup {
  readonly type?: number;
  readonly width: number;
  readonly height: number;
  readonly layers: number;
  readonly patternX: number;
  readonly patternY: number;
  readonly patternZ: number;
  readonly frames: number;
  readonly spriteIds: readonly number[];
  readonly durations?: readonly (readonly [number, number])[];
}

/** RGBA pixels of a sprite ID, or undefined when it is empty or missing. */
export type PixelSource = (spriteId: number) => Buffer | undefined;

export interface AnimationReport {
  readonly errors: string[];
  readonly warnings: string[];
  /** One line describing what was validated, e.g. "2 grupos · 4 direções · andando 8 frames". */
  readonly summary: string;
}

const DIRECTIONS = ["norte", "leste", "sul", "oeste"];
const MAX_LISTED = 6;

function isBlank(rgba: Buffer | undefined): boolean {
  if (rgba === undefined) return true;
  for (let offset = 3; offset < rgba.length; offset += 4) if (rgba[offset] !== 0) return false;
  return true;
}

/**
 * Pixels as the client will show them: fully transparent pixels compare equal whatever their color, and without
 * SPR transparency every visible pixel is opaque.
 */
function normalized(rgba: Buffer | undefined, transparency: boolean): Buffer | undefined {
  if (isBlank(rgba)) return undefined;
  const copy = Buffer.from(rgba!);
  for (let offset = 0; offset < copy.length; offset += 4) {
    if (copy[offset + 3] === 0) copy.fill(0, offset, offset + 4);
    else if (!transparency) copy[offset + 3] = 255;
  }
  return copy;
}

function isEmptyImage(image: string): boolean {
  return image.split("|").every((part) => part === "");
}

function slotIndex(group: AnimationGroup, frame: number, x: number, y: number, z: number, layer: number): number {
  return (((((frame * group.patternZ + z) * group.patternY + y) * group.patternX + x) * group.layers + layer) * group.height) * group.width;
}

function direction(group: AnimationGroup, x: number): string {
  return group.patternX === 4 ? DIRECTIONS[x]! : `padrão X ${x}`;
}

function listed(items: string[]): string {
  return items.length > MAX_LISTED ? `${items.slice(0, MAX_LISTED).join(", ")} … (+${items.length - MAX_LISTED})` : items.join(", ");
}

export function checkOutfitAnimation(label: string, groups: readonly AnimationGroup[], pixels: PixelSource): AnimationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (groups.length === 0) return { errors: [`${label}: o outfit não tem grupos de frames.`], warnings, summary: "sem grupos" };
  if (groups.length > 2) warnings.push(`${label}: ${groups.length} grupos de frames (o cliente usa parado e andando).`);
  const walkingIndex = groups.length > 1 ? 1 : 0;

  const signatures = new Map<number, string>();
  const signature = (spriteId: number): string => {
    let value = signatures.get(spriteId);
    if (value === undefined) {
      const rgba = spriteId === 0 ? undefined : pixels(spriteId);
      value = isBlank(rgba) ? "" : createHash("sha1").update(rgba!).digest("hex");
      signatures.set(spriteId, value);
    }
    return value;
  };
  // What the client draws for one frame of one direction (base outfit, layer 0; the other layers are color masks).
  const frameImage = (group: AnimationGroup, frame: number, x: number): string => {
    const start = slotIndex(group, frame, x, 0, 0, 0);
    const parts: string[] = [];
    for (let cell = 0; cell < group.width * group.height; cell += 1) parts.push(signature(group.spriteIds[start + cell] ?? 0));
    return parts.join("|");
  };

  const summaryOf = (walking: AnimationGroup): string => {
    const parts = [
      `${groups.length} grupo${groups.length === 1 ? "" : "s"}`,
      `${walking.patternX} direç${walking.patternX === 1 ? "ão" : "ões"}`,
      `${groups.length > 1 ? "andando " : ""}${walking.frames} frame${walking.frames === 1 ? "" : "s"}`,
    ];
    if (walking.patternY > 1) parts.push(`${walking.patternY - 1} addon(s)`);
    if (walking.patternZ > 1) parts.push("montaria");
    return parts.join(" · ");
  };
  // Placeholder outfits (no pixel at all) get one clear note instead of a warning per missing frame and direction.
  if (groups.every((group) => group.spriteIds.every((spriteId) => signature(spriteId) === ""))) {
    warnings.push(`${label}: o outfit não tem nenhum pixel (vazio ou invisível).`);
    return { errors, warnings, summary: `${summaryOf(groups[walkingIndex]!)} · vazio` };
  }

  groups.forEach((group, groupIndex) => {
    const name = groups.length > 1 ? (groupIndex === 0 ? "parado" : groupIndex === 1 ? "andando" : `grupo ${groupIndex + 1}`) : "grupo único";
    const expected = group.width * group.height * group.layers * group.patternX * group.patternY * group.patternZ * group.frames;
    if (group.spriteIds.length !== expected) {
      errors.push(`${label} (${name}): ${group.spriteIds.length} sprites, mas o layout exige ${expected}.`);
      return;
    }
    if (group.patternX !== 4) warnings.push(`${label} (${name}): ${group.patternX} direção(ões); outfits normalmente têm 4.`);
    if (group.durations !== undefined && group.frames > 1) {
      group.durations.forEach(([minimum, maximum], frame) => {
        if (minimum > maximum) errors.push(`${label} (${name}): o frame ${frame + 1} tem duração mínima ${minimum} maior que a máxima ${maximum}.`);
      });
      if (group.durations.length !== group.frames) errors.push(`${label} (${name}): ${group.durations.length} durações para ${group.frames} frames.`);
      if (group.durations.some(([, maximum]) => maximum === 0)) warnings.push(`${label} (${name}): há frames com duração 0.`);
    }
    const empty: string[] = [];
    const still: string[] = [];
    for (let x = 0; x < group.patternX; x += 1) {
      const images: string[] = [];
      for (let frame = 0; frame < group.frames; frame += 1) {
        const image = frameImage(group, frame, x);
        images.push(image);
        if (isEmptyImage(image)) empty.push(`${direction(group, x)} frame ${frame + 1}`);
      }
      if (groupIndex === walkingIndex && group.frames > 1 && new Set(images).size === 1 && !isEmptyImage(images[0]!)) {
        still.push(direction(group, x));
      }
    }
    if (empty.length > 0) warnings.push(`${label} (${name}): frames sem nenhum pixel: ${listed(empty)}.`);
    if (still.length > 0) warnings.push(`${label} (${name}): todos os frames são iguais em ${listed(still)} (não há movimento).`);
  });

  const walking = groups[walkingIndex]!;
  if (walking.frames < 2) {
    warnings.push(`${label}: o grupo ${groups.length > 1 ? "andando" : "do outfit"} tem 1 frame; o outfit não terá animação de movimento.`);
  }
  return { errors, warnings, summary: summaryOf(walking) };
}

export interface ComparedSide {
  readonly groups: readonly AnimationGroup[];
  readonly pixels: PixelSource;
}

/** Every group, layout field, duration and slot of `actual` must match `expected`; returns the differences. */
export function compareAnimations(label: string, expected: ComparedSide, actual: ComparedSide, transparency = true): string[] {
  const errors: string[] = [];
  if (expected.groups.length !== actual.groups.length) {
    return [`${label}: ${actual.groups.length} grupo(s) de frames em vez de ${expected.groups.length}.`];
  }
  expected.groups.forEach((source, groupIndex) => {
    const copy = actual.groups[groupIndex]!;
    const where = expected.groups.length > 1 ? ` (grupo ${groupIndex + 1})` : "";
    const fields = ["width", "height", "layers", "patternX", "patternY", "patternZ", "frames"] as const;
    const different = fields.filter((field) => source[field] !== copy[field]);
    if (different.length > 0) {
      errors.push(`${label}${where}: layout diferente em ${different.map((field) => `${field} ${source[field]}→${copy[field]}`).join(", ")}.`);
      return;
    }
    if (source.durations !== undefined && copy.durations !== undefined && source.frames > 1) {
      const changed = source.durations.findIndex(([minimum, maximum], frame) => copy.durations![frame]?.[0] !== minimum || copy.durations![frame]?.[1] !== maximum);
      if (changed >= 0) errors.push(`${label}${where}: a duração do frame ${changed + 1} mudou.`);
    }
    const mismatched: number[] = [];
    for (let slot = 0; slot < source.spriteIds.length; slot += 1) {
      const left = normalized(source.spriteIds[slot] ? expected.pixels(source.spriteIds[slot]!) : undefined, transparency);
      const right = normalized(copy.spriteIds[slot] ? actual.pixels(copy.spriteIds[slot]!) : undefined, transparency);
      if (left === undefined ? right !== undefined : right === undefined || !left.equals(right)) mismatched.push(slot);
    }
    if (mismatched.length > 0) {
      const frameSize = source.width * source.height * source.layers * source.patternX * source.patternY * source.patternZ;
      const frames = [...new Set(mismatched.map((slot) => Math.floor(slot / frameSize) + 1))];
      errors.push(`${label}${where}: ${mismatched.length} sprite(s) diferentes da origem (frames ${listed(frames.map(String))}).`);
    }
  });
  return errors;
}
