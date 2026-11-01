import {stockCompaction, type CompactionExperiment} from "./CompactionEvaluation.js";

/** A/A control: identical algorithms quantify measurement noise before testing a real candidate. */
const identityControl: CompactionExperiment = {id: "identity-control", run: stockCompaction.run};
export default identityControl;
