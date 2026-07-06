import { Args, Flags } from "@oclif/core";

import { BaseCommand } from "../base-command.js";
import { bullet } from "../lib/format.js";
import { parsePullTarget, pullCanvasFile } from "../lib/pull.js";

export default class Pull extends BaseCommand {
  static override aliases = ["download", "dl"];
  static override summary = "Download one Canvas file from an embedded file URL or ref";
  static override description = "Resolve /courses/<course>/files/<file>?verifier=... through the read-only Canvas file API, then download the signed URL to disk.";
  static override examples = [
    "<%= config.bin %> pull 11111/33333",
    "<%= config.bin %> pull 'https://canvas.example.edu/courses/11111/files/33333?verifier=...'",
    "<%= config.bin %> pull 11111/33333 -o brief.pdf --json",
  ];
  static override args = {
    target: Args.string({ description: "Canvas file URL, HTML snippet, or courseId/fileId ref", required: true }),
  };
  static override flags = {
    output: Flags.string({ char: "o", description: "file path to write" }),
    dir: Flags.string({ char: "d", description: "directory to save into", default: "." }),
  };

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(Pull);
    const target = parsePullTarget(args.target, this.configData.baseUrl);
    if (!target) this.error("Target must be a Canvas file URL, HTML link, or courseId/fileId ref.");
    const result = await pullCanvasFile(this.canvas, target, { output: flags.output, directory: flags.dir });
    const dto = {
      courseId: result.courseId,
      fileId: result.fileId,
      displayName: result.displayName,
      contentType: result.contentType,
      path: result.path,
      bytes: result.bytes,
    };

    if (!this.jsonEnabled()) {
      this.log(bullet([result.path, `${result.bytes} bytes`, result.contentType, result.displayName]));
    }
    return dto;
  }
}
