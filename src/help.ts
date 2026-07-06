import { Help, type Command, type Interfaces } from "@oclif/core";

import { AGENT_BUG_POINTER } from "./lib/agent-messages.js";

export default class EaselHelp extends Help {
  protected formatFooter(): string {
    return AGENT_BUG_POINTER;
  }

  override async showCommandHelp(command: Command.Loadable): Promise<void> {
    await super.showCommandHelp(command);
    this.log(this.formatFooter());
  }

  protected override async showRootHelp(): Promise<void> {
    await super.showRootHelp();
    this.log(this.formatFooter());
  }

  protected override async showTopicHelp(topic: Interfaces.Topic): Promise<void> {
    await super.showTopicHelp(topic);
    this.log(this.formatFooter());
  }
}
