import type {ExtensionAPI} from "@earendil-works/pi-coding-agent";
import {HerdrReporter} from "./HerdrReporter.js";

export default function herdrExtension(pi: ExtensionAPI): void {
    new HerdrReporter().register(pi);
}
