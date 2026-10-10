import { describeWithCores } from "../../support/cores.js";
import { liveNseat } from "../../support/live-nseat.js";
import { runScenarios } from "../../support/runner.js";
import { NEGATION_INDICATOR_SCENARIOS, TARGET_NAMING_SCENARIOS } from "./negation-indicator.js";
describeWithCores("live negation indicator", liveNseat, () => { runScenarios("multiplayer/negation-indicator", [...NEGATION_INDICATOR_SCENARIOS, ...TARGET_NAMING_SCENARIOS]); });
