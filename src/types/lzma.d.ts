declare module "lzma" {
  export function compress(data: ArrayLike<number> | string, mode?: number): number[];
  export function decompress(data: ArrayLike<number>): number[] | string;
}
