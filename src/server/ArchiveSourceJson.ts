import {checkArchiveSourceAbort} from "./ArchiveSourceError.js";

const enum Expect {
    Value,
    ArrayValueOrEnd,
    ObjectKeyOrEnd,
    ObjectKey,
    Colon,
    CommaOrEnd,
    Done,
}

/**
 * True only when appending bytes can complete an unfinished JSON value. This is
 * a grammar recognizer, not a parser-error-message heuristic. It materializes no
 * values and uses an iterative byte stack (one byte per nesting level, bounded
 * by the already capped source length), so adversarial depth cannot recurse.
 */
export function isIncompleteArchiveJsonPrefix(text: string, signal?: AbortSignal): boolean {
    let offset = 0;
    let expect = Expect.Value;
    let depth = 0;
    let stack = new Uint8Array(Math.min(256, text.length + 1));
    const completeValue = (): Expect => depth === 0 ? Expect.Done : Expect.CommaOrEnd;
    const push = (kind: number) => {
        if (depth === stack.length) {
            const grown = new Uint8Array(Math.min(text.length + 1, stack.length * 2));
            grown.set(stack);
            stack = grown;
        }
        stack[depth++] = kind;
    };
    let nextCheck = 0;
    const poll = () => {
        if (offset < nextCheck) return;
        checkArchiveSourceAbort(signal);
        nextCheck = offset + 4096;
    };
    checkArchiveSourceAbort(signal);
    while (offset < text.length) {
        poll();
        const character = text[offset]!;
        if (character === " " || character === "\t" || character === "\r" || character === "\n") {
            offset++;
            continue;
        }
        if (expect === Expect.Done) return false;
        if (expect === Expect.Colon) {
            if (character !== ":") return false;
            offset++;
            expect = Expect.Value;
            continue;
        }
        if (expect === Expect.CommaOrEnd) {
            if (character === (stack[depth - 1] === 1 ? "}" : "]")) {
                offset++;
                depth--;
                expect = completeValue();
            } else if (character === ",") {
                offset++;
                expect = stack[depth - 1] === 1 ? Expect.ObjectKey : Expect.Value;
            } else return false;
            continue;
        }
        if ((expect === Expect.ObjectKeyOrEnd && character === "}")
            || (expect === Expect.ArrayValueOrEnd && character === "]")) {
            offset++;
            depth--;
            expect = completeValue();
            continue;
        }
        const key = expect === Expect.ObjectKey || expect === Expect.ObjectKeyOrEnd;
        if (key && character !== '"') return false;
        if (character === '"') {
            offset++;
            let closed = false;
            while (offset < text.length) {
                poll();
                const code = text.charCodeAt(offset++);
                if (code === 0x22) {
                    closed = true;
                    break;
                }
                if (code < 0x20) return false;
                if (code !== 0x5c) continue;
                if (offset === text.length) return true;
                const escape = text[offset++]!;
                if (escape === "u") {
                    for (let digit = 0; digit < 4; digit++) {
                        if (offset === text.length) return true;
                        const hex = text.charCodeAt(offset++);
                        if (!((hex >= 0x30 && hex <= 0x39) || (hex >= 0x41 && hex <= 0x46) || (hex >= 0x61 && hex <= 0x66))) return false;
                    }
                } else if (!'"\\/bfnrt'.includes(escape)) return false;
            }
            if (!closed) return true;
            if (key) expect = Expect.Colon;
            else expect = completeValue();
            continue;
        }
        if (character === "{" || character === "[") {
            offset++;
            push(character === "{" ? 1 : 2);
            expect = character === "{" ? Expect.ObjectKeyOrEnd : Expect.ArrayValueOrEnd;
            continue;
        }
        if (character === "t" || character === "f" || character === "n") {
            const literal = character === "t" ? "true" : character === "f" ? "false" : "null";
            for (const expected of literal) {
                if (offset === text.length) return true;
                if (text[offset++] !== expected) return false;
            }
            expect = completeValue();
            continue;
        }
        if (character === "-" || isDigit(character)) {
            if (character === "-") {
                offset++;
                if (offset === text.length) return true;
            }
            if (text[offset] === "0") offset++;
            else if (text[offset] !== undefined && text[offset]! >= "1" && text[offset]! <= "9") {
                while (isDigit(text[offset])) {
                    poll();
                    offset++;
                }
            } else return false;
            if (text[offset] === ".") {
                offset++;
                if (offset === text.length) return true;
                if (!isDigit(text[offset])) return false;
                while (isDigit(text[offset])) {
                    poll();
                    offset++;
                }
            }
            if (text[offset] === "e" || text[offset] === "E") {
                offset++;
                if (text[offset] === "+" || text[offset] === "-") offset++;
                if (offset === text.length) return true;
                if (!isDigit(text[offset])) return false;
                while (isDigit(text[offset])) {
                    poll();
                    offset++;
                }
            }
            expect = completeValue();
            continue;
        }
        return false;
    }
    return expect !== Expect.Done;
}

function isDigit(character: string | undefined): boolean {
    return character !== undefined && character >= "0" && character <= "9";
}
