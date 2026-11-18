import type {RoleProfile} from "../../src/roles/RoleCatalog.js";

export const FIRST_ROLE: RoleProfile = {
    id: "10000000-0000-4000-8000-000000000001", title: "Reviewer", text: "Summarize the evidence.",
};
export const SECOND_ROLE: RoleProfile = {
    id: "20000000-0000-4000-8000-000000000002", title: "Reviewer", text: "Check assumptions.", description: "A separate role with the same title.",
};
export const THIRD_ROLE: RoleProfile = {
    id: "30000000-0000-4000-8000-000000000003", title: "Writer", text: "Draft a short overview.",
};
