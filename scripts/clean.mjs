import {rmSync} from "node:fs";

for (const path of ["build", "dist"]) {
  rmSync(new URL(`../${path}`, import.meta.url), {recursive: true, force: true});
}
