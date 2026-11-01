import {buildCondenserScenario, type CondenserScenario} from "./CondenserScenario.js";
import type {PreparedBenchmarkCase, ValueCategory} from "./BenchmarkTypes.js";

type ContinuationQuestion = {id: string; question: string; factIds: string[]};

/** Independent, synthetic conversations; draft rubrics still require independent semantic audit. */
export async function validationScenarios(): Promise<{
    development: PreparedBenchmarkCase[];
    holdout: PreparedBenchmarkCase[];
}> {
    return {
        development: scenarios.filter((scenario) => scenario.mode === "development").map(buildCondenserScenario),
        holdout: scenarios.filter((scenario) => scenario.mode === "holdout").map(buildCondenserScenario)
    };
}

// These questions are for a solver given only the resulting checkpoint, not the transcript or rubric.
export const validationContinuationQuestions: Record<string, ContinuationQuestion[]> = {
    "validation-dev-01": [
        {id: "dispatch", question: "What should I tell the volunteers about the next seed dispatch and what must stay out of it?", factIds: ["d1", "d2", "d3", "d4"]},
        {id: "release", question: "Who handles the remaining release decision, and what evidence do we actually have so far?", factIds: ["d5", "d6", "d7", "d8"]},
        {id: "desk", question: "Point me to the working records and give me the instructions for the desk handover.", factIds: ["d9", "d10", "d11", "d12"]}
    ],
    "validation-dev-02": [
        {id: "opening", question: "What can we safely promise the museum team about the opening display now?", factIds: ["d1", "d2", "d3", "d4"]},
        {id: "rights", question: "How should I finish the permissions work without overstating what has been cleared?", factIds: ["d5", "d6", "d7", "d8"]},
        {id: "handover", question: "Where should the designer pick up the current work, and what remains before printing?", factIds: ["d9", "d10", "d11", "d12"]}
    ],
    "validation-dev-03": [
        {id: "schedule", question: "Please brief the substitute producer on the current remote-broadcast plan and its boundaries.", factIds: ["d1", "d2", "d3", "d4", "d13"]},
        {id: "engineering", question: "What should engineering check next, using which record, and who can settle the readiness call?", factIds: ["d5", "d6", "d7", "d8"]},
        {id: "air", question: "What needs to be in the on-air handover, including the fallback if the remote fails?", factIds: ["d9", "d10", "d11", "d12"]}
    ],
    "validation-dev-04": [
        {id: "scope", question: "Can you remind the implementation team what the pilot is allowed to change?", factIds: ["d1", "d2", "d3", "d4"]},
        {id: "evidence", question: "Where do I inspect the pilot evidence, what has actually passed, and what is still undecided?", factIds: ["d5", "d6", "d7", "d8", "d14"]},
        {id: "next", question: "Write a brief next-step handoff for tomorrow's operator, with the right owners and resources.", factIds: ["d9", "d10", "d11", "d12", "d13"]}
    ],
    "validation-held-01": [
        {id: "public", question: "What is the current public-facing plan, and what should the front desk not promise?", factIds: ["h1", "h2", "h3", "h4"]},
        {id: "readiness", question: "Help the duty manager decide what readiness evidence is still needed and where to obtain it.", factIds: ["h5", "h6", "h7", "h8", "h13"]},
        {id: "shift", question: "What should go in the next shift handover about records, people and unfinished work?", factIds: ["h9", "h10", "h11", "h12"]}
    ],
    "validation-held-02": [
        {id: "venue", question: "Please brief the next venue on the current performance arrangement and the access constraints.", factIds: ["h1", "h2", "h3", "h4"]},
        {id: "test", question: "How do we finish the technical check, and what can we truthfully say about the evidence already collected?", factIds: ["h5", "h6", "h7", "h8"]},
        {id: "tour", question: "What should the tour coordinator do next, with which working materials and contacts?", factIds: ["h9", "h10", "h11", "h12", "h13"]}
    ],
    "validation-held-03": [
        {id: "field", question: "Give the field team the current trip brief and the limits on what they may do.", factIds: ["h1", "h2", "h3", "h4", "h14"]},
        {id: "data", question: "What can we conclude from the downloaded data, and what should the data steward inspect next?", factIds: ["h5", "h6", "h7", "h8"]},
        {id: "handoff", question: "Where are the handoff materials and who needs to resolve the remaining logistics?", factIds: ["h9", "h10", "h11", "h12", "h13"]}
    ],
    "validation-held-04": [
        {id: "production", question: "What instructions should I give the next production shift about the affected stock?", factIds: ["h1", "h2", "h3", "h4"]},
        {id: "release", question: "What is the release position right now, and what evidence and authority are relevant?", factIds: ["h5", "h6", "h7", "h8"]},
        {id: "office", question: "Please give the office team a practical handover with the working records and outstanding follow-up.", factIds: ["h9", "h10", "h11", "h12", "h13"]}
    ]
};

function fact(id: string, category: ValueCategory, critical: boolean, quote: string, statement = quote): CondenserScenario["facts"][number] {
    // Keep literal evidence intact when a critical core excludes incidental detail or explanatory reasons.
    return {id, statement, category, weight: critical ? 5 : 2, critical, quote};
}

const scenarios: CondenserScenario[] = [
    {
        id: "validation-dev-01", cluster: "validation-alder-seed-coop", mode: "development", preparationMode: "whole",
        files: {read: ["/srv/alder/seed/dispatch-june.ods"], written: ["/srv/alder/seed/desk-handover.md"], edited: []},
        turns: [
            ["I coordinate the Alder Seed Cooperative desk. Help me prepare a dispatch handover, not a gardening leaflet. We originally planned to send every reserved packet on Friday morning. Some volunteers only see the printed sheet, so I need the packing decisions separated from the seed-testing discussion. There are also plenty of leftover fair flyers on the desk; those are not orders.",
                "Let's work from the reservation list and distinguish release decisions from background notes. I can draft the handover in this conversation; I won't treat an attractive flyer or a volunteer's guess as authority to release a packet. Tell me which lots are reserved and what testing has actually happened."],
            ["The June dispatch is for Alder's existing member reservations, not new walk-in orders. There are beans, lettuce and one basil lot. The bean envelopes are already folded, but the stamps haven't been bought. I wondered about adding our children's drawing contest to the same parcel; ignore that idea for this round because the desk doesn't have the entry forms.",
                "I'll keep the dispatch focused on existing reservations. Folded envelopes aren't evidence of postage or of seed release. We can leave the contest out without turning that into a permanent rule for later dispatches. Which lot is causing the uncertainty?"],
            ["Basil lot B-17 must stay quarantined from dispatch. We saw a mould patch on the sample tray. A helper suggested rubbing off the marks and repacking, but the chair rejected that shortcut. Keep the basil reservations on the list so people don't accidentally receive substitutes they never requested. The beans and lettuce don't share that tray.",
                "B-17 stays on the reservation record but out of dispatch. I won't spread the basil quarantine to the other crops without evidence, and I won't interpret the rejected repacking idea as a permitted fallback. We should record a release owner rather than let the next desk shift improvise."],
            ["Only testing lead Leena Shah may release B-17 after reviewing the repeat germination test. Leena Shah's desk address is leena.shah@alder.example for the B-17 release review. This isn't a request to send her all member contact details. Our social-media helper knows her personally but has no testing role, so don't route the decision through the volunteer group chat.",
                "I'll identify Leena as the release authority and preserve the narrow purpose of that contact address. The handover can say to send her the lot's test evidence, without including the unrelated membership sheet or asking the group chat to vote on a release."],
            ["The repeat test has results for 20 of 50 B-17 seeds so far. We counted them this morning and photographed the tray. The remaining seeds haven't reached the counting day. One volunteer wrote 'test complete' in a draft caption because the photo was uploaded; that caption is wrong. The upload says nothing about the remaining seeds.",
                "I'll describe a partial count rather than a completed germination test. A photo can document today's tray without certifying a final result. We should keep the wrong caption out of the shift instructions so it doesn't get repeated as a release decision."],
            ["The next volunteer must record the remaining B-17 counts before asking Leena for a release review. For the ordinary dispatch, use /srv/alder/seed/dispatch-june.ods, tab Reservations, as the packing list. The old fair sign-up spreadsheet includes people who only wanted a newsletter. It would be very easy to pack twice if someone merged those files.",
                "I'll point the packer at the Reservations tab and leave the fair sign-up list out. I'll also put recording the remaining counts before the B-17 release request, not after it. That makes the next action concrete without claiming the later counts will necessarily justify release."],
            ["Members collecting in person may pick up cleared beans and lettuce on Friday. That collection exception doesn't include B-17 and doesn't cover postal dispatch. The desk has green and blue paper bags; use whichever is already open. Someone wanted different colours for each crop, but we're short of bags and colour is not a release signal.",
                "The Friday collection exception is limited to cleared beans and lettuce, while B-17 remains held. I won't encode bag colour as a safety or release rule. That should also prevent a collector's early pickup from being misread as permission to bring the postal timetable forward."],
            ["Correction from the chair: postal dispatch is now Monday, not Friday. The postal pickup was cancelled, not merely delayed within Friday. We still need the cleared packets ready for the desk shift, but don't book a private courier to preserve the original date. The Friday in-person collection arrangement stays as discussed.",
                "I'll replace the old postal date with Monday while retaining the scoped Friday collection exception. No courier workaround is planned. I'll keep preparation work distinct from the actual dispatch so the next volunteer doesn't mark parcels as sent just because they are sealed."],
            ["The handover draft is saved at /srv/alder/seed/desk-handover.md. I wrote that file myself after our last exchange; it isn't yet printed. Treasurer Oren Pike handles postage purchasing, not seed-release decisions. I still need to ask him for stamps. We did find the missing glue stick, so the stationery hunt can come off the open-items list.",
                "The file is a saved draft, not a printed or distributed handover. I'll keep Oren's purchasing role separate from Leena's lot-release role and remove the resolved glue-stick search. The useful open items are the testing counts and the operational dispatch preparations, not every errand mentioned earlier."],
            ["One final desk rule: do not email the full member address sheet to volunteers. Give each packer only their assigned labels. That's enough for this handover; please don't send anything yet. I want to check the printed wording myself after lunch, especially the line that distinguishes Monday post from Friday collections.",
                "Understood. The next handover should preserve the updated dates, the limited collection exception, the quarantine and the partial test state. It should direct packers to their assigned labels rather than the full address sheet. Nothing has been emailed or printed by me, and your wording review is still ahead."]
        ],
        facts: [
            fact("d1", "goal", false, "The June dispatch is for Alder's existing member reservations, not new walk-in orders."),
            fact("d2", "decision", true, "Correction from the chair: postal dispatch is now Monday, not Friday."),
            fact("d3", "constraint", true, "Basil lot B-17 must stay quarantined from dispatch."),
            fact("d4", "constraint", true, "Members collecting in person may pick up cleared beans and lettuce on Friday."),
            fact("d5", "constraint", true, "Only testing lead Leena Shah may release B-17 after reviewing the repeat germination test."),
            fact("d6", "identifier", false, "Leena Shah's desk address is leena.shah@alder.example for the B-17 release review."),
            fact("d7", "state", true, "The repeat test has results for 20 of 50 B-17 seeds so far.",
                "The B-17 repeat test is incomplete; partial results do not establish release readiness."),
            fact("d8", "next-action", true, "The next volunteer must record the remaining B-17 counts before asking Leena for a release review."),
            fact("d9", "identifier", false, "For the ordinary dispatch, use /srv/alder/seed/dispatch-june.ods, tab Reservations, as the packing list."),
            fact("d10", "identifier", false, "The handover draft is saved at /srv/alder/seed/desk-handover.md."),
            fact("d11", "decision", false, "Treasurer Oren Pike handles postage purchasing, not seed-release decisions."),
            fact("d12", "constraint", true, "One final desk rule: do not email the full member address sheet to volunteers.")
        ]
    },
    {
        id: "validation-dev-02", cluster: "validation-bracken-rail-museum", mode: "development", preparationMode: "split",
        files: {read: ["/exhibits/bracken/rights/register.ods"], written: [], edited: ["/exhibits/bracken/platform/labels-v3.odt"]},
        turns: [
            ["We're making a small platform-history display at Bracken Rail Museum. I'd like a designer handover, not a general history of the line. The first idea was six passenger portraits around a route map, with an opening on the 18th. The education team also sent a school quiz, but that belongs to a different project and should not creep into the label copy.",
                "I'll focus on the display's current scope, source materials and unresolved permissions. A route map and portraits can have different clearance states, so we should keep those separate. Tell me which parts are genuinely ready rather than assuming the first layout is the final brief."],
            ["The display is now opening on the 25th, replacing the 18th. The room won't be ready earlier because the cabinet glass is being replaced. We are not changing the school visit date, which is why two dates still appear in the museum diary. Please don't resolve that by moving everything to the later week.",
                "I'll apply the 25th to the display opening only. The school visit stays outside this handover's scope. I'll treat the cabinet work as context for the correction, not as proof that installation or safety inspection has already finished."],
            ["Use the 1932 route map as the central image instead of the portrait collage. We tried a mockup and the small faces were unreadable from the aisle. This isn't a ban on every portrait in the museum; it's a decision for this particular panel. There may still be room for one portrait once rights are settled.",
                "The current central image is the route map. I won't keep describing the rejected six-portrait collage as the active design, or turn this display decision into a museum-wide prohibition. We can leave a place for a cleared portrait without promising it will be available."],
            ["Portrait P-44 must not appear in print or on the display website without donor consent. We have a scan, but owning the scan isn't consent. A volunteer proposed cropping out the handwritten dedication to make the permission problem disappear; the curator rejected that. There are also two public-domain station photos we can use independently.",
                "I'll preserve the restriction on P-44 across print and the website. Cropping is not an approved rights workaround. The existence of usable station photos can support a layout alternative, but it does not change the donor's control over that portrait."],
            ["Nessa Vale at nessa.vale@bracken.example handles the P-44 donor-consent request. She is our collections registrar, not the printer. She has sent the donor a question and is waiting. P-44 donor consent is still pending. Don't call that denied; the donor simply hasn't replied and the scan remains in the internal research folder.",
                "I'll direct the consent follow-up to Nessa and record pending, not granted or refused. Her request being sent is an action completed, but it isn't the donor's decision. I'll keep internal possession of the scan distinct from permission to publish it."],
            ["The rights register is /exhibits/bracken/rights/register.ods, sheet Images. We checked the route-map entry and the two station-photo entries against their source cards. Only the route-map scan has had a resolution check. The station-photo scans haven't been opened at print size yet; a green rights cell mustn't be treated as a quality-control pass.",
                "The register tells the designer where to inspect rights, while the resolution work has a narrower scope. I'll avoid a blanket 'all images verified' statement. The photo scans may be usable, but that remains a technical check rather than a rights question."],
            ["Please use /exhibits/bracken/platform/labels-v3.odt for label edits. I edited the opening date there, but the PDF in the printer folder is still yesterday's export. The printer's quote includes a glossy finish we considered and then declined. We chose matte stock because the cabinet lighting made the glossy sample hard to read.",
                "The editable source is labels-v3.odt; the old PDF isn't a current proof. I'll keep the chosen matte stock in the handover and not revive the glossy quote as the preferred option. An edited source document doesn't mean a replacement PDF has been exported or sent."],
            ["There is one narrow copying exception: P-44 may be shown in the closed staff layout review. That is not a public preview and doesn't include sending the mockup to the museum newsletter list. The review room has a spare monitor, so nobody needs to make a public link just to see the spacing.",
                "I'll describe that as a closed staff review exception only. It won't become permission for a newsletter image or a publicly accessible proof. The spare monitor is an available convenience, not evidence that the review itself has taken place."],
            ["Curator Tomas Ives signs off the final label text before printing. He's away this morning, and I haven't asked for the signoff yet. The opening-date edit isn't his approval. We can keep working on typography in the meantime, but don't let the printer's request for a quick answer bypass the text review.",
                "The label text still needs Tomas's signoff. Typography work may continue, but I won't mark the file approved or send it to print on the strength of the date correction. The handover should keep an editable draft, a proof export and approval as separate states."],
            ["Last correction for the designer: the final caption must identify the map as a 1932 revision, not an original 1908 survey. The catalog note I first pasted was for the adjacent drawer. After Tomas approves the text, export a fresh PDF for the printer. That's a next action, not something I've done while chatting.",
                "I'll retain the 1932 revision attribution from this correction and discard the misapplied 1908 description. A fresh printer PDF comes after the curator's text approval. The existing export remains stale; neither export nor printing is complete at this checkpoint."]
        ],
        facts: [
            fact("d1", "decision", true, "The display is now opening on the 25th, replacing the 18th."),
            fact("d2", "decision", false, "Use the 1932 route map as the central image instead of the portrait collage."),
            fact("d3", "constraint", true, "Portrait P-44 must not appear in print or on the display website without donor consent."),
            fact("d4", "constraint", true, "There is one narrow copying exception: P-44 may be shown in the closed staff layout review."),
            fact("d5", "identifier", false, "Nessa Vale at nessa.vale@bracken.example handles the P-44 donor-consent request."),
            fact("d6", "state", true, "P-44 donor consent is still pending."),
            fact("d7", "identifier", false, "The rights register is /exhibits/bracken/rights/register.ods, sheet Images."),
            fact("d8", "state", true, "Only the route-map scan has had a resolution check."),
            fact("d9", "identifier", false, "Please use /exhibits/bracken/platform/labels-v3.odt for label edits."),
            fact("d10", "constraint", true, "Curator Tomas Ives signs off the final label text before printing."),
            fact("d11", "constraint", true, "Last correction for the designer: the final caption must identify the map as a 1932 revision, not an original 1908 survey."),
            fact("d12", "next-action", true, "After Tomas approves the text, export a fresh PDF for the printer.")
        ]
    },
    {
        id: "validation-dev-03", cluster: "validation-tideway-radio", mode: "development", preparationMode: "iterative",
        previousSummary: "Tideway Radio is considering a Saturday market remote at 09:00. A mobile hotspot and live caller segment were proposed. No engineering readiness decision has been recorded.",
        files: {read: ["/radio/tideway/remotes/market-checks.md"], written: ["/radio/tideway/remotes/market-cues.txt"], edited: []},
        turns: [
            ["Let's continue the Tideway market remote handover. Since the early plan in the summary, the organiser moved our slot. The market remote is now Sunday at 11:30, replacing Saturday at 09:00. We are not covering the Saturday craft auction at all. I need the substitute producer to know the current plan without ringing half the station to reconstruct it.",
                "I'll replace the older day and time rather than carry both as live options. The auction is outside the remote assignment. We should work through the connection, permissions and fallback as distinct items so the producer can make decisions on site."],
            ["Use the wired connection in the market office, not the mobile hotspot. The hotspot survived a quick test last week, but the organiser won't allow our mast on the roof. Someone suggested hanging it from a public sign instead; that isn't approved either. The office manager has agreed we can use the interior desk, though it is a tighter space.",
                "The wired office connection is the active plan. I'll leave the hotspot and makeshift mounting ideas as rejected paths, not backup instructions. Desk access gives us a location, but it doesn't establish that audio can reliably reach the studio through that connection."],
            ["We may record vendor interviews only after each vendor agrees. A stall booking isn't consent to appear on radio. For atmosphere, we can describe the market ourselves without chasing individual voices. The events team sent a cheerful paragraph saying everyone was excited to be on air, but it isn't a set of interview permissions.",
                "I'll keep individual agreement as the condition for vendor interviews. A promotional paragraph isn't consent from each speaker. That still leaves room for presenter narration, so the handover needn't imply that the entire outside broadcast is blocked by an absent interview."],
            ["The office manager permits an offline sound check before the market opens, but not an early live broadcast. That exception is only for engineering setup in the office. We also ruled out live phone-ins for this remote because the substitute producer won't have the delay controls. Please don't carry the old caller-segment idea forward.",
                "The early access is for an offline sound check, not permission to start the programme early. The caller idea is retired for this remote. I'll avoid broadening either decision into a station-wide policy; this is an operational brief for this assignment."],
            ["Engineering lead Ivo Chen at ivo.chen@tideway.example decides whether the remote link is ready. The organiser can confirm desk access but can't make that engineering call. Ivo asked us to keep the test notes in /radio/tideway/remotes/market-checks.md, section Wired link. He doesn't want screenshots scattered through private messages.",
                "I'll preserve Ivo's readiness role and the section locator for the evidence. Desk access and link readiness remain separate. A central note will let the substitute see what was tested without mistaking an organiser's welcome email for engineering approval."],
            ["Only a five-minute outgoing audio test has passed on the wired link. We haven't tested studio return audio yet. The engineer could hear us, but we couldn't tell whether the return channel was patched because the studio monitor was muted. So the successful outgoing test mustn't become 'two-way connection checked' in the handover.",
                "The evidence supports outgoing audio only. The muted studio monitor leaves return audio unresolved, not failed and not passed. I'll state that limit explicitly, because the remote producer needs to hear the studio cue before taking the next segment."],
            ["The next engineering task is a studio-return audio test before Ivo's readiness decision. If it still won't work, we don't improvise a consumer video call on air. The fallback is the studio's recorded gardening feature if the remote link fails. That recording is already in the playout library, but choosing it on the day still depends on the link situation.",
                "I'll put the return test before the readiness call and retain the recorded feature as the failure fallback. I won't imply the fallback has already aired or suggest an unapproved consumer-call workaround. The producer needs a clear branch, not a claim that the branch has been taken."],
            ["The cue sheet draft is /radio/tideway/remotes/market-cues.txt. Presenter Mara Bell must use the emergency weather wording in /radio/tideway/remotes/market-cues.txt. We had a jokey storm line in an earlier draft; that was removed because the market is beside the river and listeners need an unambiguous instruction if the alert comes through.",
                "I'll direct Mara to the cue-sheet wording rather than revive the discarded joke. The draft path is useful for the handover, but it doesn't by itself establish distribution to all presenters. Is there a scheduling limit the substitute should know alongside the fallback?"],
            ["The remote must end by 12:00 for the studio news bulletin. No extra time for the interviews if setup runs late. The market organiser offered us their whole afternoon stage slot, but that's not the station schedule. The programme can be shorter than planned; it can't slide the news. We still have to tell Mara about the new Sunday slot.",
                "I'll preserve the hard end at noon and distinguish the organiser's available stage time from broadcast allocation. A late setup means shortening the remote, not pushing news. Mara's briefing remains an outstanding communication rather than something completed by this draft."],
            ["Please leave a clear note that Mara's receipt of the revised cue sheet is unconfirmed. I sent it to the shared presenter inbox, but I don't know whether she has seen it. Don't ring her during the school pickup; the producer can check the inbox acknowledgement tomorrow. We can leave the handover here until the return-audio test happens.",
                "I'll keep receipt unconfirmed, without interpreting silence as either acknowledgement or refusal. The handover will reflect the new slot, wired plan, narrow test evidence and remaining return test. It will also preserve the noon boundary, consent condition, approved wording and recorded fallback without claiming any new actions were performed."]
        ],
        facts: [
            fact("d1", "decision", true, "The market remote is now Sunday at 11:30, replacing Saturday at 09:00."),
            fact("d2", "decision", true, "Use the wired connection in the market office, not the mobile hotspot."),
            fact("d3", "constraint", true, "We may record vendor interviews only after each vendor agrees."),
            fact("d4", "constraint", true, "The office manager permits an offline sound check before the market opens, but not an early live broadcast."),
            fact("d5", "identifier", false, "Engineering lead Ivo Chen at ivo.chen@tideway.example decides whether the remote link is ready."),
            fact("d6", "identifier", false, "Ivo asked us to keep the test notes in /radio/tideway/remotes/market-checks.md, section Wired link."),
            fact("d7", "state", true, "Only a five-minute outgoing audio test has passed on the wired link. We haven't tested studio return audio yet.",
                "Only outgoing audio has passed testing on the wired link; two-way readiness is not verified."),
            fact("d8", "next-action", true, "The next engineering task is a studio-return audio test before Ivo's readiness decision."),
            fact("d9", "decision", true, "The fallback is the studio's recorded gardening feature if the remote link fails."),
            fact("d10", "constraint", true, "Presenter Mara Bell must use the emergency weather wording in /radio/tideway/remotes/market-cues.txt."),
            fact("d11", "constraint", true, "The remote must end by 12:00 for the studio news bulletin."),
            fact("d12", "state", true, "Please leave a clear note that Mara's receipt of the revised cue sheet is unconfirmed."),
            fact("d13", "constraint", true, "We also ruled out live phone-ins for this remote because the substitute producer won't have the delay controls.",
                "Live phone-ins are ruled out for this remote.")
        ]
    },
    {
        id: "validation-dev-04", cluster: "validation-larch-timesheets", mode: "development", preparationMode: "whole",
        files: {read: ["/work/larch/pilot/reconcile.sql", "/work/larch/pilot/runbook.md"], written: ["/work/larch/pilot/results/run-08.csv"], edited: []},
        turns: [
            ["Help me hand off Larch Studio's timesheet migration pilot. We're replacing a spreadsheet workflow, not redesigning payroll. The first proposal was to trial every team for two weeks, but operations said that would be too disruptive. I'd like a precise note for tomorrow's operator rather than a pitch deck about the new product.",
                "I'll focus on the pilot's active scope, evidence, permissions and next operations. Let's separate a proposed rollout from what has actually been authorised. A trial of time entry doesn't automatically grant permission to change payroll or migrate every team."],
            ["The pilot is now limited to the illustration team, replacing the all-team proposal. Their lead can arrange volunteers, but the production and accounts teams remain on the existing workflow. We don't need to preserve the old proposal as an alternative for tomorrow. There's a slide deck with the broader plan; it's background, not current approval.",
                "I'll use illustration only as the current scope and keep the other teams on their existing workflow. The slide deck won't be treated as authority to broaden the trial. What can the operator change within the pilot environment?"],
            ["All pilot writes must stay in the sandbox tenant larch-time-sbx. No production payroll writes are authorised. We can compare exported totals locally, but not post them back into the payroll service. Someone suggested using a real payslip as a shortcut to validate the tax fields; that is outside this time-entry pilot.",
                "The sandbox tenant is the write boundary, and payroll comparison doesn't confer payroll-write permission. I'll retain the tenant's exact name so the operator doesn't choose the similarly named live tenant. The real-payslip shortcut isn't an approved task."],
            ["The one production exception is read-only lookup of employee IDs through the approved directory view. That exception doesn't permit reading bank details or editing a person record. We had an intern ask whether 'read-only' covered a spreadsheet export of everything; it does not change the scope to all columns just because no rows would be altered.",
                "I'll keep the exception narrow: employee-ID lookup through the approved view, with no broader employee-record access inferred. This belongs next to the sandbox rule so the operator doesn't read it as a general licence to investigate production data."],
            ["Use /work/larch/pilot/reconcile.sql, query weekly_totals, for the pilot comparison. The first query in that file is an old demonstration and rounds to whole hours, so it isn't appropriate here. The exported input contains job codes as well as project nicknames; compare by job code because different projects can share a nickname.",
                "I'll identify weekly_totals rather than the first query and preserve the comparison key. The operator shouldn't substitute a convenient demo query or group by the friendly nickname. Which run produced the evidence we can cite?"],
            ["Run 08 results are saved at /work/larch/pilot/results/run-08.csv. Run 08 matched totals for ordinary hourly entries only. It didn't include overnight entries or leave entries. The dashboard's green banner means the script exited normally, not that those omitted cases passed. We haven't even selected a representative overnight sample yet.",
                "I'll keep the run's success bounded to ordinary hourly entries and avoid turning a normal exit into a full migration validation. The exact output path matters for inspection, but we still need coverage beyond the current sample before a rollout decision."],
            ["Overnight-entry behaviour remains unverified. Please don't write that it loses hours either; we simply haven't checked it. Accounts are especially worried about the week boundary, but that worry is not a reproduced defect. Leave handling is also outside the current evidence. I want the handover to distinguish missing tests from known failures.",
                "I'll preserve unknown as unknown. Neither the ordinary-entry matches nor the accounts team's concern establishes overnight behaviour. We can describe a test gap without inventing a defect or quietly treating omitted cases as working."],
            ["Select an overnight sample before the next reconciliation run. QA coordinator Pema Ross at pema.ross@larch.example supplies the approved sample IDs. Don't make up employee IDs from the demo deck. Pema can advise on test selection, but cannot approve a production rollout; that authority stays with the operations owner.",
                "The next operator should obtain approved sample IDs from Pema before running the overnight comparison. I'll keep her test-data role separate from rollout authority and leave the demo deck out of the sample source. No selection or new run is complete yet."],
            ["Operations owner Joel Ames must approve any expansion beyond the illustration pilot. He has not done so. The runbook is /work/larch/pilot/runbook.md, section Rollback drill. It describes how to discard sandbox imports and return the volunteers to the spreadsheet; it is not a production database recovery procedure. We still owe Joel evidence from the drill.",
                "I'll retain Joel's approval gate and the scoped purpose of the rollback instructions. Discarding sandbox imports isn't a production recovery plan. Evidence for the drill remains an open deliverable even though the runbook already contains instructions."],
            ["Record the rollback drill outcome before asking Joel to expand the pilot. I booked a practice slot but don't yet know whether the drill will succeed. Finally, keep the comparison keyed by job code, not project nickname. That corrects an ambiguous line I used in the kickoff notes. We can stop at a handover draft; no rollout request has been sent.",
                "The handover will keep the job-code correction and the distinction between a booked drill and a completed one. It will direct the next operator to the sample selection and scoped reconciliation work, with drill evidence required before an expansion request. Nothing here authorises production writes or broader rollout."]
        ],
        facts: [
            fact("d1", "decision", true, "The pilot is now limited to the illustration team, replacing the all-team proposal."),
            fact("d2", "constraint", true, "All pilot writes must stay in the sandbox tenant larch-time-sbx."),
            fact("d3", "constraint", true, "No production payroll writes are authorised."),
            fact("d4", "constraint", true, "The one production exception is read-only lookup of employee IDs through the approved directory view."),
            fact("d5", "identifier", false, "Use /work/larch/pilot/reconcile.sql, query weekly_totals, for the pilot comparison."),
            fact("d6", "identifier", false, "Run 08 results are saved at /work/larch/pilot/results/run-08.csv."),
            fact("d7", "state", true, "Run 08 matched totals for ordinary hourly entries only."),
            fact("d8", "state", true, "Overnight-entry behaviour remains unverified."),
            fact("d9", "next-action", true, "Select an overnight sample before the next reconciliation run."),
            fact("d10", "identifier", false, "QA coordinator Pema Ross at pema.ross@larch.example supplies the approved sample IDs."),
            fact("d11", "identifier", false, "The runbook is /work/larch/pilot/runbook.md, section Rollback drill."),
            fact("d12", "constraint", true, "Record the rollback drill outcome before asking Joel to expand the pilot."),
            fact("d13", "constraint", true, "Operations owner Joel Ames must approve any expansion beyond the illustration pilot."),
            fact("d14", "constraint", true, "Finally, keep the comparison keyed by job code, not project nickname.")
        ]
    },
    {
        id: "validation-held-01", cluster: "validation-merebrook-pool", mode: "holdout", preparationMode: "split",
        files: {read: ["/facilities/merebrook/reopen/checks.xlsx"], written: ["/facilities/merebrook/reopen/desk-brief.md"], edited: []},
        turns: [
            ["I'm covering Merebrook Pool's reopening desk and need a handover for the next duty manager. The early poster said both pools would reopen Tuesday after the pump work. We've had several updates since then, and the front desk is mixing maintenance access with public opening. Please help me keep those apart rather than write a celebratory announcement.",
                "I'll organise the handover around current public access, readiness evidence and outstanding decisions. Maintenance work being scheduled or an engineer being on site doesn't establish that a pool is ready for swimmers. Tell me what changed from the poster."],
            ["The public reopening target is now Thursday, replacing Tuesday. That is still a target, not a statement that the doors will open regardless of the checks. The town's sports calendar has already copied Tuesday, so the desk needs the correction prominently. The car park resurfacing date hasn't changed and isn't part of this readiness decision.",
                "I'll replace Tuesday with the Thursday target and retain its conditional status. The unrelated car park work won't be silently rescheduled. We should name the public area covered, because a facility can be partly available without every pool being released."],
            ["Only the teaching pool is in the reopening plan. The main pool remains closed for the cracked return fitting. We considered using the shallow end of the main pool for classes, but the maintenance team ruled it out. Don't direct overflow swimmers there just because the teaching pool's capacity is lower.",
                "The teaching pool is the sole reopening scope, and the main pool remains unavailable. I'll retain the rejected shallow-end idea only as context, not as a crowding workaround. A reopening plan for the building isn't permission to use every water area."],
            ["No public swimming may start until duty manager Salma Noor signs the teaching-pool release. Salma can be reached at salma.noor@merebrook.example for the reopening release review. The contractor can report completed pump work, but doesn't sign our public release. Reception should not use the contractor's departure as the opening trigger.",
                "I'll preserve Salma's release authority and the purpose of her contact. Contractor completion and public release are distinct states. The desk needs a clear authority rather than an inference from who has packed up their tools."],
            ["The teaching-pool chlorine spot check passed at 08:00 today. That was one sample at one time. The full circulation-cycle check has not been completed. We have a technician booked for it tomorrow, but the booking isn't a result. I don't know yet whether they'll find a problem; leave that as unknown, not an assumed pass or failure.",
                "I'll record the passed spot check with its time and the incomplete cycle check separately. A single sample isn't evidence about a whole circulation cycle. The booking can support a next action without being turned into a completed inspection."],
            ["The readiness log is /facilities/merebrook/reopen/checks.xlsx, sheet Teaching pool. There is also a Main pool sheet with older green cells from last month; those do not apply here. Before asking Salma for release, record the full circulation-cycle check in the teaching-pool log. She needs the actual result, not a calendar invite.",
                "The exact workbook and sheet will be in the handover. I'll put logging the cycle-check result before the release request and keep last month's main-pool cells out of the teaching-pool evidence. Nothing here establishes the outcome of tomorrow's check."],
            ["Maintenance staff may enter the teaching-pool enclosure for testing while it is closed to swimmers. That exception is not early access for swim instructors' private lessons. An instructor offered to bring a tiny class as a trial, but the answer was no. We can test the equipment without treating customers as part of the test procedure.",
                "I'll describe access for maintenance testing only, not a general staff or small-class exception. The rejected private-lesson idea won't appear as a fallback. The public release gate applies even if the proposed class would be very small."],
            ["I've saved the desk briefing draft at /facilities/merebrook/reopen/desk-brief.md. It hasn't been approved for publication, and the social team is still holding the old poster. Desk lead Ari Finch should update the public booking notice after Salma's release. Ari handles the booking system, not the water-quality judgement.",
                "I'll keep the draft's existence separate from publication approval and the release decision. Ari has an operational notice task after release, not authority to make that release. The old poster's existence is a communication risk, not evidence that Tuesday remains current."],
            ["One more unresolved item: the teaching-pool hoist service report has not arrived. The engineer said they'd email it but didn't tell us the outcome on the phone. Don't say the hoist failed and don't mark it serviced. I want the next shift to chase the report rather than repeat rumours from the changing rooms.",
                "I'll preserve the missing-report state without inferring the service outcome. The next shift needs the actual report, not either a positive or negative conclusion from silence. This remains separate from the pump contractor's completed work and the water-test evidence."],
            ["Correction to the queue note: reserve the first reopened teaching-pool session for existing lesson transfers, not general drop-ins. That's only the first session, not a permanent members-only policy. No one has changed the booking system yet. Please stop at the handover so Ari can make the right change once the release is actually signed.",
                "I'll retain the limited first-session allocation and won't broaden it to every future session. Booking changes remain unperformed. The handover will carry the Thursday target, teaching-pool-only scope, release gate, incomplete checks and missing report without promising a public opening prematurely."]
        ],
        facts: [
            fact("h1", "decision", true, "The public reopening target is now Thursday, replacing Tuesday."),
            fact("h2", "decision", true, "Only the teaching pool is in the reopening plan."),
            fact("h3", "constraint", true, "The main pool remains closed for the cracked return fitting."),
            fact("h4", "constraint", true, "Correction to the queue note: reserve the first reopened teaching-pool session for existing lesson transfers, not general drop-ins."),
            fact("h5", "constraint", true, "No public swimming may start until duty manager Salma Noor signs the teaching-pool release."),
            fact("h6", "identifier", false, "Salma can be reached at salma.noor@merebrook.example for the reopening release review."),
            fact("h7", "state", true, "The teaching-pool chlorine spot check passed at 08:00 today. That was one sample at one time. The full circulation-cycle check has not been completed.",
                "The teaching-pool chlorine spot check passed; that does not verify a full circulation cycle."),
            fact("h8", "next-action", true, "Before asking Salma for release, record the full circulation-cycle check in the teaching-pool log."),
            fact("h9", "identifier", false, "The readiness log is /facilities/merebrook/reopen/checks.xlsx, sheet Teaching pool."),
            fact("h10", "identifier", false, "I've saved the desk briefing draft at /facilities/merebrook/reopen/desk-brief.md."),
            fact("h11", "next-action", true, "Desk lead Ari Finch should update the public booking notice after Salma's release."),
            fact("h12", "state", true, "One more unresolved item: the teaching-pool hoist service report has not arrived."),
            fact("h13", "state", true, "The full circulation-cycle check has not been completed.")
        ]
    },
    {
        id: "validation-held-02", cluster: "validation-orchard-caption-tour", mode: "holdout", preparationMode: "iterative",
        previousSummary: "Orchard Players plan to project captions above the stage for their touring play. Venue rehearsal and cue checks remain to be arranged. A QR-code transcript was suggested as a fallback, with no access-team decision yet.",
        files: {read: ["/tour/orchard/access/cue-check.tsv"], written: [], edited: ["/tour/orchard/access/captions-v6.srt"]},
        turns: [
            ["We need to pick up the Orchard Players access handover for our next venue. The earlier summary still has the overhead projection idea. At Wren Hall, captions will use the stage-left display, replacing overhead projection. The overhead beam hits a decorative arch and makes the second line unreadable. This is a venue arrangement, not a rewrite of the touring show's whole technical rider.",
                "I'll use the stage-left display for Wren Hall and not keep overhead projection as an equally valid current option. The arch explains the correction without establishing anything about other venues. Let's separate equipment placement from caption content and access approval."],
            ["The Wren Hall performance is Friday at 19:15, not the 19:00 shown in the first email. The box office changed it to fit the bus timetable. Our crew call hasn't moved, so don't shift every item in the schedule by fifteen minutes. The foyer poetry reading is a separate booking and doesn't need to appear in our cue sheet.",
                "I'll update the performance time alone and leave the crew call unchanged. The poetry event is background, not part of the show's cues. The venue team will need a concise current arrangement rather than a merged calendar of every event in the building."],
            ["Keep the aisle beside the stage-left display clear for wheelchair access. We tested a display stand there and moved its feet back out of the route. A volunteer offered beanbags to make the front area welcoming, but they would narrow that aisle. The spare chairs can go against the back wall instead, away from the access route.",
                "I'll preserve the clear-aisle requirement and not revive the beanbag idea as an approved front-row layout. The adjusted stand placement is useful context, but it doesn't substitute for checking the route when the room is finally set up for the audience."],
            ["A printed transcript is available on request as a supplement, not a replacement for live captions. The access team rejected QR-code-only delivery because some audience members won't have suitable phones. We should not describe a phone download as the fallback that lets us perform without captions if the display fails.",
                "I'll keep the printed transcript supplementary and the QR-only idea rejected. The existence of a transcript doesn't establish permission to remove live captions. We need an access owner for any decision about a failed display, rather than an improvised workaround by the venue."],
            ["Access lead Zuri Lane at zuri.lane@orchard.example handles caption-access decisions for this stop. The venue technician owns the physical screen setup, not that decision. Zuri wants cue-test notes in /tour/orchard/access/cue-check.tsv under venue code WREN. There are rows for other halls in the same file, and those tests don't prove Wren is ready.",
                "I'll keep Zuri's decision role separate from the technician's equipment role, with the WREN locator for evidence. Prior venue rows can inform setup but cannot be presented as current-site testing. What was actually checked at Wren so far?"],
            ["At Wren, only Act One caption timing has been checked against the actors. Act Two hasn't been rehearsed with the screen. The operator ran through the Act Two file alone to look for missing lines, but that doesn't test the actors' pacing. Please don't compress those two very different checks into 'both acts rehearsed'.",
                "The actor-timing evidence covers Act One only. A solo file run may catch omissions without validating live timing. I'll retain the distinction so the next operator can target the remaining rehearsal instead of repeating the work that already happened."],
            ["Rehearse Act Two caption timing before Zuri makes the access-readiness decision. She hasn't made that decision yet. The director would like to save time by skipping the rehearsal and using last month's timings, but that proposal hasn't been accepted. We changed a scene transition since that venue, so we can't just assume those cue intervals transfer.",
                "I'll put the Act Two rehearsal before the readiness decision and leave the director's shortcut as an unaccepted proposal. I won't label the show access-ready because one act has been checked, or assume a changed transition has necessarily broken the cues before it's tested."],
            ["The working caption file is /tour/orchard/access/captions-v6.srt. I corrected the speaker labels there this morning. The laptop's Desktop folder has a v4 copy for an old workshop, and the two look very similar in the file picker. Do not edit that workshop copy or treat its modification time as evidence about the touring captions.",
                "I'll point the caption operator to captions-v6.srt and keep the old workshop copy out of the active handover. Your speaker-label edits are complete in the working file, but I won't infer that every downstream machine has received the latest version."],
            ["Tour coordinator Ben Osei must confirm that Wren Hall has received captions-v6.srt. I sent a link, but the venue hasn't acknowledged it. Venue receipt of the revised caption file is unconfirmed. The link isn't public publicity; it's for the technician's setup work. Ben can follow up through the venue's normal production email thread.",
                "I'll retain receipt as unconfirmed and assign Ben the confirmation task. A sent link is not proof of download, and the setup link isn't an invitation to publish the caption file. The handover can name the existing production thread without inventing another contact channel."],
            ["One exception to the file freeze: the caption operator may fix obvious spelling errors during the closed technical rehearsal. Changes to dialogue meaning still require the director's approval. That is not permission to rewrite jokes or remove lines to keep up with the actors. The front-of-house volunteer's note about a confusing line should go to the director, not straight into the file.",
                "I'll keep the rehearsal exception limited to obvious spelling fixes and preserve the director's approval for meaning changes. The access handover will retain the stage-left setup, clear aisle, current time, partial timing test and pending receipt confirmation. No access-readiness decision or venue acknowledgement has been inferred."]
        ],
        facts: [
            fact("h1", "decision", true, "At Wren Hall, captions will use the stage-left display, replacing overhead projection."),
            fact("h2", "decision", true, "The Wren Hall performance is Friday at 19:15, not the 19:00 shown in the first email."),
            fact("h3", "constraint", true, "Keep the aisle beside the stage-left display clear for wheelchair access."),
            fact("h4", "constraint", true, "A printed transcript is available on request as a supplement, not a replacement for live captions."),
            fact("h5", "identifier", false, "Access lead Zuri Lane at zuri.lane@orchard.example handles caption-access decisions for this stop."),
            fact("h6", "identifier", false, "Zuri wants cue-test notes in /tour/orchard/access/cue-check.tsv under venue code WREN."),
            fact("h7", "state", true, "At Wren, only Act One caption timing has been checked against the actors."),
            fact("h8", "next-action", true, "Rehearse Act Two caption timing before Zuri makes the access-readiness decision."),
            fact("h9", "identifier", false, "The working caption file is /tour/orchard/access/captions-v6.srt."),
            fact("h10", "state", true, "Venue receipt of the revised caption file is unconfirmed."),
            fact("h11", "constraint", true, "One exception to the file freeze: the caption operator may fix obvious spelling errors during the closed technical rehearsal."),
            fact("h12", "constraint", true, "Changes to dialogue meaning still require the director's approval."),
            fact("h13", "next-action", true, "Tour coordinator Ben Osei must confirm that Wren Hall has received captions-v6.srt.")
        ]
    },
    {
        id: "validation-held-03", cluster: "validation-fenlight-ecology", mode: "holdout", preparationMode: "whole",
        files: {read: ["/field/fenlight/autumn/retrieval.gpkg"], written: ["/field/fenlight/autumn/logger-review.csv"], edited: []},
        turns: [
            ["I need a field-team handover for Fenlight Ecology's autumn logger retrieval. We first planned the east-bank route with a boat pickup. The reserve warden has updated the access arrangements, and the data steward is also asking whether the first downloads are usable. Please keep trip logistics separate from conclusions about the temperature data.",
                "I'll distinguish the current route and access limits from data verification. A successful retrieval or download doesn't by itself show that the measurements are calibrated. Tell me the route correction first so the team doesn't set off with the old plan."],
            ["Use the west-bank footpath for retrieval, replacing the east-bank boat plan. The landing stage is closed for repairs. A volunteer suggested launching a canoe from the picnic area, but the warden didn't approve that alternative. We can carry the smaller cases by foot; the heavy display board from the outreach event can stay in the office.",
                "I'll keep the west-bank footpath as the active route and not turn the canoe suggestion into a fallback. The display board isn't field equipment for this task. We should specify the retrieval targets rather than let the route change expand into a general reserve survey."],
            ["Retrieve loggers F2 and F3 only on this trip. F1 is still part of the nesting-area study and must remain undisturbed. Its marker flag looks faded, but that isn't an instruction to pull the logger. If the team notices a problem with F1, they can report it to the study lead without touching the equipment.",
                "The retrieval scope is F2 and F3, with F1 left in place. I'll preserve the difference between reporting an observation and interfering with a separate study. A faded marker does not grant the field team permission to remove or service the logger."],
            ["The warden permits crossing the meadow only along the marked boardwalk. That exception doesn't permit taking a shorter line across the wet grass. We must be off the reserve by 16:00. Sunset is later, but the permit's cutoff is about the warden's lock-up schedule, not whether we can still see the path.",
                "I'll retain the boardwalk-only crossing and the 16:00 exit limit. The later sunset is not an extension of the access window. The handover should make the exit deadline operational rather than burying it among general weather notes."],
            ["The retrieval map is /field/fenlight/autumn/retrieval.gpkg, layer approved_route. There's a draft_route layer from the old boat plan; leave that hidden. Field lead Elian Ward at elian.ward@fenlight.example coordinates the permit check with the warden. The volunteer driver can organise transport but isn't the person to negotiate reserve access.",
                "I'll give the team the exact map layer and Elian's permit-check role. Hiding the draft route is a practical way to avoid selecting it, but the source of authority is the approved arrangement, not whichever layer happens to be visible on someone's device."],
            ["For data context, F2's first download has valid checksums. No one has compared F2 temperatures with the reference probe yet. The graph looks smooth, which encouraged a volunteer to call it calibrated, but smoothness isn't a calibration check. The data steward asked us to preserve the original download rather than replace it with a corrected spreadsheet.",
                "I'll record checksum validity as transfer integrity, not measurement accuracy. The reference-probe comparison remains absent, and a smooth curve doesn't fill that gap. We should keep the original data intact while making the verification status clear to the next analyst."],
            ["F3's data quality is still unknown because its logger hasn't been downloaded. The blank status cell is not a failed sensor diagnosis. We won't know until retrieval and download whether the battery lasted. Someone found an old F3 graph in the outreach folder, but that's last season and cannot stand in for the current logger's data.",
                "I'll preserve F3 as not yet downloaded with unknown current quality. Last season's graph is a distractor, not a current validation result. There is no basis here to call F3 failed or healthy, or to mark retrieval as completed."],
            ["The data-review ledger is /field/fenlight/autumn/logger-review.csv. Data steward Mina Cole must compare F2 with the reference probe before publishing calibrated temperatures. She can log checksum results before that, but those rows must not be advertised as a calibration certificate. The public newsletter deadline doesn't change the evidence requirement.",
                "I'll direct Mina's review to the ledger and retain the reference comparison as the publishing gate for calibrated temperatures. An integrity result can be recorded honestly without promoting it into a calibration claim. The newsletter can wait for evidence rather than dictate what has passed."],
            ["The key pickup from the warden is not confirmed yet. Elian left a message, and we don't know whether the warden can meet at the proposed time. Don't infer permission from the fact that the gate was open last weekend. The team needs an affirmative arrangement before travelling, or they may end up waiting outside with the cases.",
                "I'll leave key pickup unconfirmed and the contact follow-up with Elian. An open gate on a previous visit isn't confirmation for this trip. We can preserve the route and target scope without claiming the logistics are ready."],
            ["Please ask transport coordinator Jo Bell to confirm the vehicle booking after Elian settles key pickup. The booking request is in, but no vehicle is allocated yet. The shared minibus might be available; it isn't reserved just because we used it in spring. That should be enough for the handover until we hear from the warden and Mina starts the probe comparison.",
                "I'll keep transport confirmation after the key arrangement, with Jo responsible for the booking follow-up. The minibus remains a possibility, not an allocated vehicle. The handover will preserve the route correction, scoped retrieval, permit limits, partial F2 evidence and genuinely unknown F3 status without inventing completed work."]
        ],
        facts: [
            fact("h1", "decision", true, "Use the west-bank footpath for retrieval, replacing the east-bank boat plan."),
            fact("h2", "constraint", true, "Retrieve loggers F2 and F3 only on this trip."),
            fact("h3", "constraint", true, "The warden permits crossing the meadow only along the marked boardwalk."),
            fact("h4", "constraint", true, "We must be off the reserve by 16:00."),
            fact("h5", "state", true, "For data context, F2's first download has valid checksums."),
            fact("h6", "state", true, "No one has compared F2 temperatures with the reference probe yet."),
            fact("h7", "state", true, "F3's data quality is still unknown because its logger hasn't been downloaded."),
            fact("h8", "constraint", true, "Data steward Mina Cole must compare F2 with the reference probe before publishing calibrated temperatures."),
            fact("h9", "identifier", false, "The retrieval map is /field/fenlight/autumn/retrieval.gpkg, layer approved_route."),
            fact("h10", "identifier", false, "Field lead Elian Ward at elian.ward@fenlight.example coordinates the permit check with the warden."),
            fact("h11", "identifier", false, "The data-review ledger is /field/fenlight/autumn/logger-review.csv."),
            fact("h12", "next-action", true, "Please ask transport coordinator Jo Bell to confirm the vehicle booking after Elian settles key pickup."),
            fact("h13", "state", true, "The key pickup from the warden is not confirmed yet."),
            fact("h14", "constraint", true, "The team needs an affirmative arrangement before travelling, or they may end up waiting outside with the cases.",
                "The field team needs an affirmative key-pickup arrangement with the warden before travelling.")
        ]
    },
    {
        id: "validation-held-04", cluster: "validation-millstone-bakery", mode: "holdout", preparationMode: "split",
        files: {read: ["/quality/millstone/labels/checks.ods"], written: ["/quality/millstone/labels/shift-note.md"], edited: []},
        turns: [
            ["I'm preparing a shift handover for Millstone Bakery after a label mismatch on some oat rolls. This isn't a request for a new recipe. We initially thought every tray from the morning run needed holding, but the traceability review narrowed it down. Please help the next supervisor distinguish affected stock, test evidence and customer communications.",
                "I'll separate the stock decision from the investigation and communication work. An early broad hold can be superseded by a traceability correction, but we should preserve exactly which lot remains affected and avoid assuming that a narrowed scope means the issue is fully resolved."],
            ["The hold now covers lot OR-62 only, replacing the whole-morning hold. Lot OR-61 used the correct labels and has been released by quality. Don't keep OR-61 on the affected list just because it was baked on the same shift. The evening team has a separate product run, which isn't part of this label review.",
                "I'll replace the broad hold with OR-62 and keep OR-61's release distinct from any decision about OR-62. The separate evening run won't be silently pulled into the investigation. We still need the current action limits for the held lot."],
            ["OR-62 must not leave the bakery until quality manager Rafi Dey signs its release. Production can count trays and check labels, but cannot release them on its own. A driver offered to deliver now and swap labels at the café; we rejected that. The hold applies before stock leaves our control, not just before it reaches the café display.",
                "I'll preserve Rafi's release gate and the rejected delivery-and-relabel workaround. Counting stock is permitted preparation, not an authorisation to dispatch. The next shift needs that boundary even if a customer is pressing for an early delivery."],
            ["The replacement label for OR-62 must list sesame. The dough record includes sesame topping, while the misprinted label omitted it. This isn't evidence about other allergens or a new sesame-free formulation. Please don't add a 'free from' claim to make the new label sound reassuring; we are correcting the actual ingredient declaration.",
                "I'll keep sesame as a required declaration for this lot and avoid inventing claims about other allergens. A corrected label should reflect the product record, not marketing reassurance. We should also distinguish a checked label design from checking every physical sleeve."],
            ["Only one replacement label proof has been checked against the OR-62 recipe record. The printed sleeves haven't all been inspected. The designer's export looked correct, but the printer could still have mixed old and new sleeves in the box. A green tick on the proof isn't evidence that the whole stock is ready to use.",
                "The checked evidence is one proof, not the entire sleeve supply. I'll leave physical sleeve inspection as outstanding and avoid turning the designer's correct export into a blanket production pass. The next shift should know exactly what the green tick means."],
            ["Inspect every replacement sleeve before applying it to OR-62. Rafi Dey at rafi.dey@millstone.example handles the OR-62 release review. He wants the sleeve inspection count and traceability note, not a photo of one good label. The sales manager can relay customer questions, but has no release authority even if a delivery is already booked.",
                "I'll retain the all-sleeve inspection task and direct the release evidence to Rafi for this lot. A single-photo shortcut is rejected, and the sales manager's urgency doesn't replace quality authority. No message or release request is being sent by this handover draft."],
            ["Use /quality/millstone/labels/checks.ods, sheet OR-62, for inspection results. The OR-61 sheet is complete but belongs to the released lot. We also have a packaging stock count in another workbook; that's useful for ordering but not the source of the inspection signoff. Please don't merge a count of boxes with a count of checked sleeves.",
                "I'll point the supervisor at the OR-62 sheet and keep ordering inventory separate from inspection evidence. The completed neighbouring sheet can't stand in for this lot. That should prevent a convenience copy-and-paste from turning an unfinished check into a recorded pass."],
            ["For internal photos only, one unsealed OR-62 sample may be taken to the quality desk. That exception doesn't permit tasting, selling or handing samples to visitors. We considered a staff tasting to avoid waste, but it was not approved. The sample must stay identified as held stock while quality reviews it.",
                "I'll keep the sample exception to an identified, unsealed item at the quality desk for internal photos. It is not a consumption or distribution exception. The rejected tasting idea will not reappear as a permitted waste-reduction measure."],
            ["I've saved the shift note at /quality/millstone/labels/shift-note.md. Customer liaison Hana Reed is preparing the café notification draft. It hasn't been sent, and we don't know whether the café has any earlier OR-62 delivery; the dispatch ledger is being checked. Don't tell them stock is definitely present or definitely absent before that check returns.",
                "I'll preserve the saved note, Hana's draft role and the uncertainty about earlier dispatch. Preparing a customer message doesn't mean it was sent, and the pending ledger check can't support a conclusion either way. The handover can leave that question open without losing the action owner."],
            ["Final correction: reconcile the OR-62 dispatch ledger before Hana sends the café notification. My earlier suggestion to send a generic reassurance first was wrong. The notification needs the actual dispatch position. The OR-62 dispatch position is still unknown pending the ledger check. Please don't invent an answer just to make the handover feel finished. We can stop here while quality and dispatch do their checks.",
                "I'll replace the generic-reassurance sequence with ledger reconciliation before notification. The dispatch position remains unknown and the café message unsent. The handover will keep the narrowed lot hold, sesame declaration, limited proof evidence, full sleeve-inspection task and release authority without claiming any unfinished checks have passed."]
        ],
        facts: [
            fact("h1", "decision", true, "The hold now covers lot OR-62 only, replacing the whole-morning hold."),
            fact("h2", "constraint", true, "OR-62 must not leave the bakery until quality manager Rafi Dey signs its release."),
            fact("h3", "constraint", true, "The replacement label for OR-62 must list sesame."),
            fact("h4", "constraint", true, "For internal photos only, one unsealed OR-62 sample may be taken to the quality desk."),
            fact("h5", "state", true, "Only one replacement label proof has been checked against the OR-62 recipe record. The printed sleeves haven't all been inspected.",
                "The OR-62 replacement-label proof has been checked against the recipe record; this does not verify the physical sleeves."),
            fact("h6", "state", true, "The printed sleeves haven't all been inspected."),
            fact("h7", "next-action", true, "Inspect every replacement sleeve before applying it to OR-62."),
            fact("h8", "identifier", false, "Rafi Dey at rafi.dey@millstone.example handles the OR-62 release review."),
            fact("h9", "identifier", false, "Use /quality/millstone/labels/checks.ods, sheet OR-62, for inspection results."),
            fact("h10", "identifier", false, "I've saved the shift note at /quality/millstone/labels/shift-note.md."),
            fact("h11", "next-action", false, "Customer liaison Hana Reed is preparing the café notification draft."),
            fact("h12", "constraint", true, "Final correction: reconcile the OR-62 dispatch ledger before Hana sends the café notification."),
            fact("h13", "state", true, "The OR-62 dispatch position is still unknown pending the ledger check.")
        ]
    }
];
