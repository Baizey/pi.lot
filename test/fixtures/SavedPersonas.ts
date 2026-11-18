export const SAVED_PERSONAS = {personas: [
    {id: "594d5cdb-0c03-4da8-b497-ad32c77888c7", name: "Legion", prompt: "Speak in plural."},
]};

export const UPDATED_PERSONAS = {personas: [
    {...SAVED_PERSONAS.personas[0]!, prompt: "Use first-person plural."},
]};

export const OTHER_PERSONA = {id: "1740d190-e7b6-404d-8342-0de29b019808", name: "Analyst", prompt: "Distinguish evidence from inference."};
