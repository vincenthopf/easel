import { BaseCommand } from "../base-command.js";

const BUG_URL = "https://vjh.io/bugreport";

export default class Bug extends BaseCommand {
  static override aliases = ["report", "feedback"];
  static override summary = "Report easel bugs or unexpected output";
  static override description = "Print the bug-report URL and the details agents should include.";
  static override examples = ["<%= config.bin %> bug", "<%= config.bin %> report"];

  protected override requiresCanvasToken(): boolean {
    return false;
  }

  async run(): Promise<unknown> {
    await this.parse(Bug);
    const dto = {
      url: BUG_URL,
      include: ["command run", "flags", "expected vs actual", "easel version"],
    };

    if (!this.jsonEnabled()) {
      this.log(BUG_URL);
      this.log("Include:");
      for (const item of dto.include) this.log(`- ${item}`);
    }
    return dto;
  }
}
