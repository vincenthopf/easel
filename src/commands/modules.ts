import { Args } from "@oclif/core";

import { BaseCommand, courseArg } from "../base-command.js";
import { bullet } from "../lib/format.js";
import { sanitizeUrl } from "../lib/http.js";

export default class Modules extends BaseCommand {
  static override aliases = ["module", "mods"];
  static override summary = "List modules and item references for a course";
  static override description = "List Canvas modules. Page items include slugs and File items include content identifiers.";
  static override examples = ["<%= config.bin %> modules BIO101", "<%= config.bin %> mods 11111", "<%= config.bin %> modules CHEM101 --json"];
  static override args = { course: Args.string(courseArg) };

  async run(): Promise<unknown> {
    const { args } = await this.parse(Modules);
    const course = await this.canvas.resolveCourse(args.course!);
    const modules = await this.canvas.modules(course.id);
    const dto = modules.map((module) => ({
      id: module.id,
      name: module.name,
      position: module.position,
      items: (module.items ?? []).map((item) => ({
        id: item.id,
        contentId: item.content_id,
        title: item.title,
        type: item.type,
        pageSlug: item.page_url,
        url: item.html_url ? sanitizeUrl(item.html_url) : undefined,
      })),
    }));
    if (!this.jsonEnabled()) {
      for (const module of dto) {
        this.log(`${course.code} · ${module.position ?? "-"} · ${module.name}`);
        for (const item of module.items) {
          this.log(`  ${bullet([item.type, item.title, item.pageSlug ? `slug ${item.pageSlug}` : undefined, item.contentId ? `content ${item.contentId}` : undefined])}`);
        }
      }
    }
    return { course, modules: dto };
  }
}
