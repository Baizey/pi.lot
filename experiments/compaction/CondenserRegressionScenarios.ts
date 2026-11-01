import {buildCondenserScenario, type CondenserScenario} from "./CondenserScenario.js";
import {validationContinuationQuestions, validationScenarios} from "./CondenserValidationScenarios.js";
import type {PreparedBenchmarkCase, ValueCategory, ValueFact} from "./BenchmarkTypes.js";
import {validateRubric} from "./ValueRetention.js";

type ContinuationQuestion = {id: string; question: string; factIds: string[]};

/** Seen cases become development regressions; only the four newly authored conversations are held out. */
export async function regressionScenarios(): Promise<{
    development: PreparedBenchmarkCase[];
    holdout: PreparedBenchmarkCase[];
}> {
    const seen = await validationScenarios();
    const development = structuredClone([...seen.development, ...seen.holdout]);
    for (const item of development) {
        if (item.definition.id === "validation-held-03") {
            addFact(item, "h15", "constraint", "The data steward asked us to preserve the original download rather than replace it with a corrected spreadsheet.");
        }
        if (item.definition.id === "validation-held-02") {
            const rubric = item.definition.rubric;
            const transcriptFact = rubric?.facts.find(({id}) => id === "h4");
            if (!rubric || !transcriptFact) throw new Error("Missing seen transcript criterion");
            transcriptFact.statement = "A printed transcript is supplementary and must not replace live captions.";
            addFact(item, "h14", "constraint", "A printed transcript is available on request as a supplement, not a replacement for live captions.",
                "A printed transcript is available on request.");
        }
    }
    return {development, holdout: newScenarios.map(buildCondenserScenario)};
}

export const regressionContinuationQuestions: Record<string, ContinuationQuestion[]> = {
    ...seenQuestions(),
    "regression-held-01": [
        {id: "repair", question: "What treatment plan should the conservator follow now, and what boundaries should the bench team observe?", factIds: ["h1", "h2", "h3", "h4", "h13"]},
        {id: "evidence", question: "What do the material checks establish, what is needed for the treatment decision, and what should we offer as the client's next appointment?", factIds: ["h5", "h6", "h7", "h8", "h14"]},
        {id: "records", question: "Where should I pick up the working records, and what needs to happen with the client's other request?", factIds: ["h9", "h10", "h11", "h12", "h15"]}
    ],
    "regression-held-02": [
        {id: "release", question: "What should I tell the engineer about the release scope and the rules for handling the source bundle?", factIds: ["h1", "h2", "h3", "h4", "h13"]},
        {id: "verification", question: "What is proven by the current tests, and what should happen before the release decision?", factIds: ["h5", "h6", "h7", "h8", "h14"]},
        {id: "workstreams", question: "Point the next maintainer to the useful artifacts and explain how the two open workstreams relate.", factIds: ["h9", "h10", "h11", "h12", "h15"]}
    ],
    "regression-held-03": [
        {id: "service", question: "What is the current transport plan and what exceptions can dispatch actually make?", factIds: ["h1", "h2", "h3", "h4", "h13"]},
        {id: "checks", question: "What can we safely conclude from the route checks, and who needs to settle the remaining readiness work?", factIds: ["h5", "h6", "h7", "h8"]},
        {id: "office", question: "Where are the office’s working records, what is the parent-communication position, and how should the separate office follow-up proceed?", factIds: ["h9", "h10", "h11", "h12", "h14"]}
    ],
    "regression-held-04": [
        {id: "movement", question: "Please give the courier the current movement brief and the limits of their assignment.", factIds: ["h1", "h2", "h3", "h4", "h15"]},
        {id: "condition", question: "What is actually verified about the loan, and what evidence and authority do we need before it can proceed?", factIds: ["h5", "h6", "h7", "h8", "h13"]},
        {id: "coordination", question: "Where should the coordinator pick up the records, who owns the separate programme-image request, and what is the gate for publishing the image?", factIds: ["h9", "h10", "h11", "h12", "h14"]}
    ]
};

function addFact(item: PreparedBenchmarkCase, id: string, category: ValueCategory, quote: string, statement = quote): void {
    const input = item.reference.find(({id, text}) => (id === "history" || id === "turn-prefix") && text.includes(quote));
    const rubric = item.definition.rubric;
    if (!input || !rubric) throw new Error(`Missing native regression evidence: ${item.definition.id}:${id}`);
    const addition: ValueFact = {id, category, statement, weight: 5, critical: true, evidence: [{inputId: input.id, quote}]};
    item.definition.rubric = validateRubric({...rubric, status: "draft", facts: [...rubric.facts, addition]}, item.reference);
}

function seenQuestions(): Record<string, ContinuationQuestion[]> {
    const questions = structuredClone(validationContinuationQuestions);
    const data = questions["validation-held-03"]?.find(({id}) => id === "data");
    const venue = questions["validation-held-02"]?.find(({id}) => id === "venue");
    if (!data || !venue) throw new Error("Missing seen continuation mapping");
    data.factIds.push("h15");
    venue.factIds.push("h14");
    return questions;
}

function fact(id: string, category: ValueCategory, critical: boolean, quote: string, statement = quote): CondenserScenario["facts"][number] {
    return {id, category, critical, weight: critical ? 5 : 2, quote, statement};
}

const newScenarios: CondenserScenario[] = [
    {
        id: "regression-held-01", cluster: "regression-saffron-textile-studio", mode: "holdout", preparationMode: "whole",
        files: {read: ["/commissions/saffron/R28/treatment.ods"], written: ["/commissions/saffron/R28/bench-plan.md"], edited: []},
        turns: [
            ["I'm planning work on a woven wall hanging at Saffron Textile Studio, commission R28. The customer originally asked us to wash the whole piece and fit a new hanging sleeve. After examining the backing, our conservator has changed the treatment proposal. I need a practical bench plan, not advice about cleaning textiles in general. The customer's framing enquiry is separate.",
                "Let's keep this specific to R28 and separate treatment permission, material checks and framing. A customer asking for a wash doesn't establish that it is suitable after examination. What treatment is now proposed, and what may the bench team do before the customer responds?"],
            ["R28 is now a dry surface-cleaning job, replacing the wet-wash proposal. The backing has water-sensitive annotations. Do not detach R28's original backing or erase its annotations. We once replaced a backing on a different commission, and an apprentice has suggested copying that approach here. That earlier job is not authority for altering this one.",
                "I'll replace wet washing with dry surface cleaning and retain the original backing and annotations. The old commission is a rejected analogy rather than an approved method. We can make a bench plan without representing every conservation decision as already authorised by the client."],
            ["Only lead conservator Priya Moss may approve adhesive use on R28. The client can choose the display arrangement, but our treatment approval remains with Priya. The bench team may make a reversible paper mockup without adhesive. That exception is for checking the sleeve position; it doesn't permit a temporary glue dot on the original textile.",
                "The mockup can be prepared without adhesive, while adhesive use needs Priya's approval. I'll keep that exception away from the textile itself. A display preference from the customer doesn't replace the treatment judgement about what material can touch the original."],
            ["The cotton support fabric passed the dry abrasion test. The proposed sleeve thread has not had a colour-transfer test. An assistant checked that its shade looks close to the hanging, but that is not the same test. We don't yet know whether it will transfer colour. Leave that unknown rather than deciding the match proves suitability or that the untested thread is defective.",
                "The support-fabric result is positive but item-specific. The sleeve thread remains unverified for colour transfer, and visual matching isn't a substitute. I'll avoid an overall 'materials passed' label that would hide the difference between these two components."],
            ["Before Priya decides on sleeve attachment, complete the sleeve-thread colour-transfer test. Priya Moss at priya.moss@saffron.example receives R28 treatment evidence. Send her the test note and the proposed attachment drawing, not the customer's unrelated framing estimate. She is on site tomorrow, but her being in the building won't itself constitute approval.",
                "I'll put the thread test before the attachment decision and preserve the purpose of Priya's address. A conversation or a completed test may inform her decision without being that decision. The framing estimate can proceed through its own contact rather than become part of the conservation evidence."],
            ["The treatment register is /commissions/saffron/R28/treatment.ods, sheet Materials. The Bench sheet has a list of tools, so don't put a test result there merely because it is the first sheet visible. We have two candidate cotton rolls on the shelf; the abrasion result belongs to the roll recorded in Materials, not whichever roll the next person finds nearest the table.",
                "I'll point the bench team at Materials for test identity and results. Tool availability and material verification are different records. The instruction shouldn't let an operator transfer the tested roll's result to another cotton roll just because the materials look similar."],
            ["The bench plan draft is /commissions/saffron/R28/bench-plan.md. I saved it after yesterday's inspection; it is not the signed treatment agreement. Client coordinator Ellis Rowe is still waiting for the client's display-height choice. The customer received two drawings and hasn't replied. Don't treat the lower drawing being listed first as a selection.",
                "I'll keep the saved plan separate from the agreement and the unresolved display choice. Ellis owns that customer follow-up. Neither drawing order nor the existence of a draft can supply a missing client decision, and there is no need to guess it to keep the material testing moving."],
            ["The framing quote may proceed independently of the sleeve-thread test. Ellis can ask the frame maker about costs without telling them to start making a frame. We rejected combining both into one urgent approval email because the customer kept answering only the price question. The bench team shouldn't wait for the quote to do the colour-transfer test.",
                "I'll make the two workstreams explicit: the quote can progress independently, while the test feeds the attachment decision. A cost enquiry is not a fabrication order. Separating the messages should make the missing display choice clearer instead of smuggling it into a pricing response."],
            ["Keep the untreated-condition photographs unchanged in the commission record. We can annotate copies for the proposed sleeve position, but don't paint the proposed sleeve onto the originals and overwrite them. Those photographs document what arrived. A polished client presentation is useful, but it must not replace the evidence of the untreated state.",
                "I'll preserve the untreated photographs and use copies for layout annotations. That gives us a presentation artifact without losing the baseline condition record. It also keeps the customer-facing drawing from being confused with a photograph of work that has already been performed."],
            ["One timing correction: offer the client a review appointment after the thread test, not a collection appointment. The hanging will not be ready to collect just because the test is done. Client approval of the display height is still pending. Please leave the plan at that point; I want Priya to see the test before anyone promises an installation date.",
                "The next appointment offer is a review after testing, not a completion promise. I'll retain pending client selection and Priya's treatment role, with no installation date invented. The bench plan can support reversible preparation and the separate framing enquiry while preserving the original textile and condition evidence."]
        ],
        facts: [
            fact("h1", "decision", true, "R28 is now a dry surface-cleaning job, replacing the wet-wash proposal."),
            fact("h2", "constraint", true, "Do not detach R28's original backing or erase its annotations."),
            fact("h3", "constraint", true, "Only lead conservator Priya Moss may approve adhesive use on R28."),
            fact("h4", "constraint", true, "The bench team may make a reversible paper mockup without adhesive."),
            fact("h5", "state", true, "The cotton support fabric passed the dry abrasion test."),
            fact("h6", "state", true, "The proposed sleeve thread has not had a colour-transfer test."),
            fact("h7", "next-action", true, "Before Priya decides on sleeve attachment, complete the sleeve-thread colour-transfer test."),
            fact("h8", "identifier", false, "Priya Moss at priya.moss@saffron.example receives R28 treatment evidence."),
            fact("h9", "identifier", false, "The treatment register is /commissions/saffron/R28/treatment.ods, sheet Materials."),
            fact("h10", "identifier", false, "The bench plan draft is /commissions/saffron/R28/bench-plan.md."),
            fact("h11", "state", true, "Client coordinator Ellis Rowe is still waiting for the client's display-height choice."),
            fact("h12", "decision", true, "The framing quote may proceed independently of the sleeve-thread test."),
            fact("h13", "constraint", true, "Keep the untreated-condition photographs unchanged in the commission record."),
            fact("h14", "next-action", true, "One timing correction: offer the client a review appointment after the thread test, not a collection appointment."),
            fact("h15", "constraint", true, "Ellis can ask the frame maker about costs without telling them to start making a frame.",
                "The framing cost enquiry must not instruct the frame maker to begin fabrication.")
        ]
    },
    {
        id: "regression-held-02", cluster: "regression-ridgepath-offline-app", mode: "holdout", preparationMode: "split",
        files: {read: ["/repos/ridgepath/mobile/src/cache/importBundle.ts", "/repos/ridgepath/mobile/test/bundle-import.test.ts"], written: ["/repos/ridgepath/review/import-notes.md"], edited: []},
        turns: [
            ["Let's work through Ridgepath's offline-map import bug before I give it to another maintainer. The first issue report said to rebuild the download service, but we have narrowed the problem to the phone's import path. I want an implementation plan and an honest test summary. The documentation team is separately rewriting the onboarding guide; that isn't a prerequisite for investigating this bug.",
                "I'll separate the client importer work from the service and documentation projects. We should preserve the original failing input, identify the current scope and keep tests tied to the actual behaviour they exercise. What has the investigation established?"],
            ["The fix is scoped to the Android bundle importer, not the download service. iOS uses a different importer and is not in this patch. We considered changing the shared download format, but that would require all clients to update together. The mobile lead rejected that route for this patch, so don't leave a server-format migration in the implementation checklist.",
                "The active patch is Android importer only, with no format migration or inferred iOS work. I'll keep the rejected shared-format idea as context rather than a task. That should make the next maintainer's test and review boundaries much clearer."],
            ["Preserve the failing signed bundle unchanged as the regression input. A helper unpacked it and proposed deleting its duplicate index row, but doing that would remove the failure we need to reproduce. Working copies may be unpacked into a temporary directory for inspection. That exception does not permit repacking or overwriting the signed fixture itself.",
                "I'll preserve the failing signed fixture and limit unpacking to working copies in a temporary directory. Deleting a troublesome row would destroy the reproduction, not fix the importer. The signature also means an edited archive shouldn't be presented as the original input."],
            ["Never bypass signature verification to make this import succeed. The bug is after the signature check, when the importer installs the index. We saw a comment suggesting a debug flag that disables the verifier; it was a diagnostic suggestion, not an accepted patch. We need the importer to handle the valid signed bundle while retaining the verifier's normal protection.",
                "I'll retain signature verification as a boundary. A successful import with verification disabled would not demonstrate the required fix. The implementation plan should target installation after verification and leave the diagnostic shortcut out of the shipped behaviour."],
            ["The entry point is /repos/ridgepath/mobile/src/cache/importBundle.ts, function installIndex. Review that function before changing the parser. The JSON parser already accepts the index as supplied; the exception happens when rows are installed into the local cache. There's a nearby demo function for sample maps, but it isn't called by Android bundle import.",
                "I'll point the maintainer at installIndex rather than the nearby demo or the shared parser. Parser acceptance narrows the investigation but doesn't mean installation is correct. We can use the actual call path to avoid a plausible-looking change that never affects the failing operation."],
            ["The new test currently proves that a clean import succeeds. It does not test upgrading an existing cached region. Our first CI label said 'import scenarios passed', which sounded broader than it was. The upgrade fixture hasn't been run, and we don't know whether old cached rows survive correctly. Please keep that outcome unknown, not a presumed failure or pass.",
                "I'll describe the successful clean import separately from the untested upgrade. A broad CI label can't expand the evidence. The upgrade path needs a targeted run with an existing cache rather than an inference from a fresh installation."],
            ["Run the existing-cache upgrade test before release lead Farah Lin decides whether the patch can ship. Farah Lin at farah.lin@ridgepath.example owns the Android patch release decision. The issue reporter can confirm their symptom, but cannot approve a release. Farah wants the clean-import and upgrade outcomes reported separately, including any failure rather than a single green summary.",
                "I'll retain the upgrade-test gate and Farah's release role. A reporter's confirmation can be useful evidence without becoming shipment authority. The next maintainer should report what each path actually did, not collapse distinct results into the CI job's overall colour."],
            ["The test target is /repos/ridgepath/mobile/test/bundle-import.test.ts, case upgrade-keeps-existing-region. We haven't changed that fixture to match a desired result. The implementation notes are /repos/ridgepath/review/import-notes.md. I saved the notes, but there is no merged patch yet; a draft implementation on a laptop isn't a release candidate simply because the test runner starts.",
                "I'll give the maintainer the exact test case and notes path. The saved notes are a working artifact, not proof of a merge or release candidate. We'll preserve the test input and let observed behaviour determine the result rather than adjusting the fixture to make a badge green."],
            ["The onboarding-guide rewrite may continue independently of the importer patch. Documentation owner Hugo Beck must not describe the upgrade fix as shipped until Farah releases it. Hugo can improve the existing setup screenshots now. We dropped the idea of blocking every guide edit behind the code issue because that would delay unrelated corrections without improving the release evidence.",
                "I'll keep independent documentation edits moving while gating claims that the upgrade fix has shipped. That distinguishes workstream independence from permission to announce an unreleased feature. It also avoids coupling harmless screenshot corrections to a technical decision they don't inform."],
            ["Final scope note: do not delete users' existing cached regions as a workaround. The product owner rejected the 'clear all maps and retry' suggestion. If the upgrade test exposes more trouble, report it to Farah rather than quietly adding destructive recovery. Leave the patch unmerged here until we've reviewed that test outcome.",
                "I'll preserve the rejection of destructive cache clearing and keep the patch unmerged. The next step is the existing-cache test and an evidence-based decision, not a workaround that discards user data. The source bundle stays intact, verification stays enabled, and documentation can continue without claiming release."]
        ],
        facts: [
            fact("h1", "decision", true, "The fix is scoped to the Android bundle importer, not the download service."),
            fact("h2", "constraint", true, "Preserve the failing signed bundle unchanged as the regression input."),
            fact("h3", "constraint", true, "Working copies may be unpacked into a temporary directory for inspection."),
            fact("h4", "constraint", true, "Never bypass signature verification to make this import succeed."),
            fact("h5", "state", true, "The new test currently proves that a clean import succeeds."),
            fact("h6", "state", true, "The upgrade fixture hasn't been run, and we don't know whether old cached rows survive correctly.",
                "Upgrading an existing cached region remains untested."),
            fact("h7", "next-action", true, "Run the existing-cache upgrade test before release lead Farah Lin decides whether the patch can ship."),
            fact("h8", "identifier", false, "Farah Lin at farah.lin@ridgepath.example owns the Android patch release decision."),
            fact("h9", "identifier", false, "The entry point is /repos/ridgepath/mobile/src/cache/importBundle.ts, function installIndex."),
            fact("h10", "identifier", false, "The test target is /repos/ridgepath/mobile/test/bundle-import.test.ts, case upgrade-keeps-existing-region."),
            fact("h11", "decision", true, "The onboarding-guide rewrite may continue independently of the importer patch."),
            fact("h12", "constraint", true, "Documentation owner Hugo Beck must not describe the upgrade fix as shipped until Farah releases it."),
            fact("h13", "constraint", true, "Final scope note: do not delete users' existing cached regions as a workaround."),
            fact("h14", "constraint", true, "If the upgrade test exposes more trouble, report it to Farah rather than quietly adding destructive recovery. Leave the patch unmerged here until we've reviewed that test outcome.",
                "The importer patch is unmerged and must stay unmerged until the existing-cache upgrade-test outcome has been reviewed."),
            fact("h15", "identifier", false, "The implementation notes are /repos/ridgepath/review/import-notes.md.")
        ]
    },
    {
        id: "regression-held-03", cluster: "regression-briar-school-transport", mode: "holdout", preparationMode: "iterative",
        previousSummary: "Briar Learning Trust proposed combining the north and south afternoon school routes. Dispatch is considering a leisure-centre stop as a relief pickup point. No route-readiness decision has been recorded.",
        files: {read: ["/transport/briar/routes/autumn.ods"], written: ["/transport/briar/review/south-run.md"], edited: []},
        turns: [
            ["Help me prepare the actual route change for Briar Learning Trust rather than another options paper. Since the early summary, dispatch has rejected the combined route. Keep north and south afternoon routes separate, replacing the merger proposal. The north route's driver stays on their current timetable. The change we're working through is the south route's temporary stop during the roadworks.",
                "I'll replace the merged-route proposal with separate afternoon routes and focus the change on the south stop. The older options shouldn't survive as current dispatch instructions. We should keep driver allocation, safeguarding and route checks distinct rather than assume a timetable edit settles them all."],
            ["The south route's temporary pickup is the library forecourt, not the leisure centre. The council won't let a bus wait in the leisure-centre access lane. A parent suggested the supermarket entrance nearby, but we have no agreement to use it. The library has agreed to the forecourt location; that doesn't yet establish every aspect of boarding readiness.",
                "The library forecourt is the current pickup location. I'll leave the leisure-centre lane and supermarket suggestion out of the active route. Location agreement and boarding readiness are different things, so we should identify which checks have actually happened there."],
            ["Dispatch may arrange a parent-authorised taxi only for a child whose accessible bus place is unavailable. This is an individual exception, not permission to put the whole route in taxis. Parents must agree to their own child's arrangement. A class representative cannot consent on behalf of all families just because they manage the message group.",
                "I'll keep taxi use conditional on an unavailable accessible bus place and authorisation from that child's parent. A group organiser isn't a substitute for individual agreement. The exception shouldn't become a general escape from resolving route capacity or boarding access."],
            ["Do not share the full pupil contact list with substitute drivers. Give each driver only their allocated route's authorised pickup details. The route spreadsheet contains emergency contacts in a separate protected sheet. A substitute asked for the whole workbook to make searching easier, but that convenience request was refused. We can supply the scoped extract without exposing unrelated families.",
                "I'll preserve the limited-driver-information rule and the difference between a scoped extract and the whole workbook. Refusing the broad request doesn't mean the substitute gets no useful pickup information. The office needs to prepare the correct route-specific details."],
            ["Transport officer Naila Hart at naila.hart@briar.example signs off the south-route readiness review. The library manager can confirm site access but cannot sign that transport review. The route authority is not delegated to the parent message group. Naila asked us to distinguish the bus turning check from the boarding and supervision checks in the evidence.",
                "I'll keep Naila as the readiness authority and use her contact for that review. A library access email is relevant but narrower. Separate evidence fields will prevent a successful vehicle manoeuvre from being reported as proof of a safe and complete boarding arrangement."],
            ["The south-route bus passed the forecourt turning check. Wheelchair boarding at the temporary stop remains unverified. The driver measured the turning space with the actual bus, but the boarding trial has not happened. We don't know yet whether the existing boarding position will work; don't call it inaccessible based solely on the fact that we still need to test it.",
                "I'll record a passed turning check and an unknown boarding result, not an overall route pass or a failed accessibility judgement. The actual-bus manoeuvre is useful evidence for one item only. The next check needs to address boarding directly."],
            ["Complete the wheelchair-boarding trial before Naila's readiness decision. The working route register is /transport/briar/routes/autumn.ods, sheet South temporary. North current is a different sheet and hasn't changed. We shouldn't copy its old readiness tick into the temporary-stop row just to make the workbook look consistent. The records can honestly show different states.",
                "I'll place the boarding trial before the readiness decision and retain the exact south-sheet locator. A completed north-route check doesn't transfer to a different stop. The office should keep the temporary row pending rather than treat visual consistency in the workbook as the goal."],
            ["Keep the original roadworks diversion notice unchanged in the route record. We can mark a working copy with our pickup point, but don't overwrite the council's original PDF. It matters if the closure dates change later. The review note is /transport/briar/review/south-run.md; I've saved the turning-check result there, not the boarding outcome.",
                "I'll preserve the original diversion notice and use a copy for annotations. The saved review note contains the turning result only, so its existence doesn't imply that boarding was tested. Keeping both baseline evidence and working interpretation should make later route changes easier to trace."],
            ["Family liaison Owen Park is preparing the south-route parent notice. That drafting can continue while the boarding trial is arranged. Do not send the revised pickup notice until Naila signs the readiness review. We rejected sending a definite stop instruction now and correcting it later if needed; families need one dependable instruction, not a provisional message disguised as final.",
                "I'll let Owen draft in parallel but retain the readiness gate before sending. That is a scoped dependency: preparing wording isn't blocked, while public instructions are. The rejected send-and-correct approach won't be presented as a useful fallback."],
            ["Also, the lost-property inventory can continue independently of the south-route review. It belongs to the office team and doesn't need Naila's signature. Someone bundled it into the route change meeting because the same children use the bus, but there's no operational dependency. We still haven't sent the pickup notice; please stop at a planning note until the boarding trial result is available.",
                "I'll keep lost property moving independently and the pickup notice unsent. The planning note will retain separate routes, the library location, individual taxi exception, scoped pupil information, item-specific checks and the readiness authority. Neither the route review nor unrelated office work is complete merely because we have a draft."]
        ],
        facts: [
            fact("h1", "decision", true, "Keep north and south afternoon routes separate, replacing the merger proposal."),
            fact("h2", "decision", true, "The south route's temporary pickup is the library forecourt, not the leisure centre."),
            fact("h3", "constraint", true, "Dispatch may arrange a parent-authorised taxi only for a child whose accessible bus place is unavailable."),
            fact("h4", "constraint", true, "Do not share the full pupil contact list with substitute drivers. Give each driver only their allocated route's authorised pickup details.",
                "Give substitute drivers only their allocated route's authorised pickup details, not the full pupil contact list."),
            fact("h5", "state", true, "The south-route bus passed the forecourt turning check."),
            fact("h6", "state", true, "Wheelchair boarding at the temporary stop remains unverified."),
            fact("h7", "next-action", true, "Complete the wheelchair-boarding trial before Naila's readiness decision."),
            fact("h8", "identifier", false, "Transport officer Naila Hart at naila.hart@briar.example signs off the south-route readiness review."),
            fact("h9", "identifier", false, "The working route register is /transport/briar/routes/autumn.ods, sheet South temporary."),
            fact("h10", "identifier", false, "The review note is /transport/briar/review/south-run.md; I've saved the turning-check result there, not the boarding outcome.",
                "The south-route review note is /transport/briar/review/south-run.md."),
            fact("h11", "constraint", true, "Do not send the revised pickup notice until Naila signs the readiness review."),
            fact("h12", "decision", true, "Also, the lost-property inventory can continue independently of the south-route review."),
            fact("h13", "constraint", true, "Keep the original roadworks diversion notice unchanged in the route record."),
            fact("h14", "next-action", false, "Family liaison Owen Park is preparing the south-route parent notice.")
        ]
    },
    {
        id: "regression-held-04", cluster: "regression-copperleaf-instrument-loans", mode: "holdout", preparationMode: "whole",
        files: {read: ["/loans/copperleaf/C19/condition.ods"], written: ["/loans/copperleaf/C19/transfer-plan.md"], edited: []},
        turns: [
            ["We need to arrange Copperleaf Music Trust's cello loan C19 for a visiting ensemble. The original plan was to send it straight to their rehearsal hotel, but the venue has offered a secure instrument room. I'd like help planning the transfer and distinguishing what has actually been checked. The ensemble's request for a programme photograph is separate from the physical loan.",
                "I'll separate the instrument movement, condition evidence and programme-image request. A secure-room offer can change the destination without proving that the loan is ready to travel. What destination is current, and who controls the release decision?"],
            ["Deliver C19 to the venue's secure instrument room, replacing the hotel delivery. The hotel's reception won't accept responsibility for an unattended instrument. The ensemble suggested leaving it with their bus driver, but we rejected that too. The courier must hand C19 directly to the named venue custodian. A front-door delivery photograph is not a signed handover.",
                "I'll use the secure instrument room as the destination and retain direct handover to the named custodian. The hotel and bus-driver options are rejected. Proof that a courier reached the building wouldn't establish that custody transferred correctly."],
            ["Loan officer Mei Sutton must authorise C19's dispatch after reviewing the condition record. The courier can arrange a collection window but cannot release the instrument from the trust. Mei Sutton at mei.sutton@copperleaf.example receives the C19 dispatch evidence. Please keep the programme-image discussion off that evidence thread so the practical release question doesn't get lost.",
                "I'll preserve Mei's authority and the purpose of her address. A booked collection isn't a dispatch authorisation. The image enquiry can progress separately without being mistaken for the evidence Mei needs about the instrument and its transport condition."],
            ["The custodian may open the outer transport cover to inspect the sealed case label. That exception does not permit opening the instrument case before the condition handover. We considered letting the ensemble tune the cello immediately on arrival, but the loan officer rejected access before the recorded handover. The seal is for custody traceability, not a substitute for the condition record.",
                "I'll keep the exception to the outer cover and label inspection. It doesn't authorise opening the instrument case or early tuning. The recorded condition handover and the seal serve different purposes, so neither should be used to bypass the other."],
            ["The cello body inspection is complete with no new damage recorded. The bow has not had its condition inspection yet. A photograph shows the bow in the case, but doesn't show the hair and tip well enough for that check. Don't promote the body inspection into a claim that every loaned item is cleared, or assume the unseen parts of the bow are damaged.",
                "The body has a completed, bounded result while the bow remains uninspected. The photograph establishes presence but not condition of the parts needed for the bow check. I'll keep the remaining outcome unknown and avoid a blanket 'loan checked' statement."],
            ["Complete the bow inspection before Mei's dispatch authorisation. The condition ledger is /loans/copperleaf/C19/condition.ods, sheet Outbound items. There is a Returned items sheet from a previous loan; don't copy its ticks across. The body row and bow row can have different states until the remaining inspection is actually done.",
                "I'll put the bow check before the dispatch decision and point the inspector at Outbound items. A returned-item result from an earlier loan doesn't establish current condition. Distinct row states are useful, not an inconsistency to hide by copying a checkmark."],
            ["Retain the trust's original pre-loan photographs unchanged. Cropped copies may be used to illustrate the handover form, but they must not replace the originals. A volunteer wanted to clean up a scuff digitally for the ensemble's programme, which is exactly why we need a separate presentation copy. A retouched image cannot be our baseline condition evidence.",
                "I'll preserve the pre-loan originals and distinguish presentation copies from condition evidence. Cropping or retouching for a programme doesn't alter the underlying loan record. That separation also prevents an attractive image from being mistaken for proof of the instrument's physical state."],
            ["The transfer-plan draft is /loans/copperleaf/C19/transfer-plan.md. Logistics coordinator Dev Malik is waiting for the venue custodian's collection acknowledgement. We sent the proposed window but haven't had a reply. Custodian acknowledgement of the transfer window remains unconfirmed. Don't treat the venue offering a room earlier as agreement to this particular handover time.",
                "I'll retain the draft locator and Dev's outstanding acknowledgement task. Room availability and acceptance of a specific custody handover window are separate. The next coordinator should chase that response rather than telling the courier that the slot is confirmed."],
            ["The programme-photo permission request may proceed independently of the bow inspection. Rights coordinator Cora Ellis handles that request, not Mei's dispatch authorisation. The ensemble still needs permission before publishing the trust's image. We rejected holding every image email until the physical loan is ready because the rights review can happen without moving the cello.",
                "I'll keep the image-permission workstream independent but preserve its own publication gate. Cora's role doesn't become authority to dispatch the cello, and Mei's physical-loan review doesn't itself grant image rights. Progress on one thread shouldn't silently complete the other."],
            ["Please include that the courier slot is only requested, not booked. Dev will confirm it after the custodian acknowledges the window. We don't yet know which vehicle the courier will allocate. Don't promise the ensemble a delivery time from the quotation alone. Leave this as a transfer plan until the bow record, Mei's authorisation and the practical acknowledgements are in place.",
                "I'll keep the courier request and unconfirmed custodian response separate from a booking. No delivery time or vehicle allocation has been inferred. The plan will retain the new destination, direct custody transfer, limited cover-opening exception, item-specific condition evidence, preserved originals and independent image-rights work."]
        ],
        facts: [
            fact("h1", "decision", true, "Deliver C19 to the venue's secure instrument room, replacing the hotel delivery."),
            fact("h2", "constraint", true, "The courier must hand C19 directly to the named venue custodian."),
            fact("h3", "constraint", true, "Loan officer Mei Sutton must authorise C19's dispatch after reviewing the condition record."),
            fact("h4", "constraint", true, "The custodian may open the outer transport cover to inspect the sealed case label. That exception does not permit opening the instrument case before the condition handover.",
                "The custodian may open the outer cover for sealed-label inspection, but not the instrument case before the condition handover."),
            fact("h5", "state", true, "The cello body inspection is complete with no new damage recorded."),
            fact("h6", "state", true, "The bow has not had its condition inspection yet."),
            fact("h7", "next-action", true, "Complete the bow inspection before Mei's dispatch authorisation."),
            fact("h8", "identifier", false, "Mei Sutton at mei.sutton@copperleaf.example receives the C19 dispatch evidence."),
            fact("h9", "identifier", false, "The condition ledger is /loans/copperleaf/C19/condition.ods, sheet Outbound items."),
            fact("h10", "identifier", false, "The transfer-plan draft is /loans/copperleaf/C19/transfer-plan.md."),
            fact("h11", "state", true, "Custodian acknowledgement of the transfer window remains unconfirmed."),
            fact("h12", "decision", true, "The programme-photo permission request may proceed independently of the bow inspection. Rights coordinator Cora Ellis handles that request, not Mei's dispatch authorisation.",
                "Cora Ellis handles the programme-photo permission request independently of the bow inspection and separately from Mei's dispatch authorisation."),
            fact("h13", "constraint", true, "Retain the trust's original pre-loan photographs unchanged."),
            fact("h14", "constraint", true, "The ensemble still needs permission before publishing the trust's image."),
            fact("h15", "state", true, "Please include that the courier slot is only requested, not booked. Dev will confirm it after the custodian acknowledges the window.",
                "The courier slot is requested, not booked; Dev Malik will confirm it after the custodian acknowledges the transfer window.")
        ]
    }
];
