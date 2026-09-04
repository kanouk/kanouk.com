import { env } from "virtual:emdash/env";
import type { StudioSessionEnvironment } from "./session";

export function studioEnvironment(): StudioSessionEnvironment {
	return (env ?? {}) as StudioSessionEnvironment;
}
