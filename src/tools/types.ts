type NumberSchema = {
    type: "number"
    minimum: number
    maximum: number
    default: number
    description: string
}
type StringSchema = {
    type: "string"
    description: string
    minLength?: number
    maxLength: number
    defaultValue?: string
}
type ObjectSchema = {
    type: "object";
    additionalProperties: false;
    properties: Record<string, unknown>
    required?: string[]
}
type ArraySchema = {
    type: "array"
    items: Record<string, unknown>
    description: string
    defaultValue?: unknown[]
}
type EnumSchema = {
    type: "string"
    enum: string[]
    description: string
    defaultValue?: string
}

export function objectSchema(properties: Record<string, unknown>, required: string[] = []): ObjectSchema {
    return {type: "object", additionalProperties: false, properties, ...(required.length > 0 ? {required} : {})};
}

export function stringSchema(description: string, maxLength = 10_000): StringSchema {
    return {type: "string", description, minLength: 1, maxLength};
}

export function numberSchema(
    description: string,
    minimum: number,
    maximum: number,
    defaultValue: number,
): NumberSchema {
    return {type: "number", description, minimum, maximum, default: defaultValue};
}

export function enumSchema(values: string[], description: string, defaultValue?: string): EnumSchema {
    return {type: "string", enum: values, description, ...(defaultValue === undefined ? {} : {default: defaultValue})};
}

export function arraySchema(
    items: Record<string, unknown>,
    description: string,
    defaultValue?: unknown[],
): ArraySchema {
    return {type: "array", items, description, ...(defaultValue === undefined ? {} : {default: defaultValue})};
}
