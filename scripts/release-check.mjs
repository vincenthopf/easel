import { readFile } from "node:fs/promises";

const packageData = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const manifest = JSON.parse(await readFile(new URL("../.release-please-manifest.json", import.meta.url), "utf8"));
const manifestVersion = manifest["."];
if (manifestVersion !== packageData.version) {
  throw new Error(`release version mismatch: package.json=${packageData.version}, manifest=${manifestVersion}`);
}
const expectedTag = process.env.RELEASE_TAG;
if (expectedTag && expectedTag !== `v${packageData.version}`) {
  throw new Error(`release tag mismatch: expected v${packageData.version}, received ${expectedTag}`);
}
console.log(`release version ${packageData.version} is consistent`);
