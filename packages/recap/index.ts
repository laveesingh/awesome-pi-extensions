import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Recap } from "./src/recap.js";
import { PiChatBackend } from "./src/chat.js";

export default function recapExtension(pi: ExtensionAPI): void {
  new Recap(new PiChatBackend()).install(pi);
}
