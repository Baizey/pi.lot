import {PolicyFallbackResponse} from "../policy/types.js";
import {SettingsChoice} from "./SettingsChoice.js";

const RESPONSES: Record<PolicyFallbackResponse, string> = {
    allow: "Allow unmatched operations",
    deny: "Deny unmatched operations",
    ask_user: "Ask you for approval",
    ask_llm: "Ask the policy-review model",
};

export function policyFallbackChoice(current: string, done: (value?: string) => void): SettingsChoice {
    return new SettingsChoice(Object.values(PolicyFallbackResponse).map((response) => ({
        value: response, label: response, description: RESPONSES[response],
    })), current, done);
}
