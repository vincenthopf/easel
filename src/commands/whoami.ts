import { BaseCommand } from "../base-command.js";

export default class Whoami extends BaseCommand {
  static override aliases = ["me"];
  static override summary = "Show the Canvas account behind the token";
  static override description = "Show the Canvas profile for the configured token.";
  static override examples = ["<%= config.bin %> whoami", "<%= config.bin %> me --json"];

  async run(): Promise<unknown> {
    await this.parse(Whoami);
    const profile = await this.canvas.profile();
    const dto = {
      id: profile.id,
      name: profile.name,
      shortName: profile.short_name,
      email: profile.primary_email,
      login: profile.login_id,
    };
    if (!this.jsonEnabled()) this.log(`${dto.name} · ${dto.email ?? dto.login ?? "Canvas user"} · id ${dto.id}`);
    return dto;
  }
}
