import { resolve, relative, join } from "path";
import { WORKSPACE_DIR } from "./workspace.ts";
import { existsSync } from "fs";
import { readdir, stat, readFile } from "fs/promises";

const SKILLS_DIR = resolve(WORKSPACE_DIR, "skills");

function isSafeSkillName(name: string): boolean {
    return /^[A-Za-z0-9._-]+$/.test(name);
}

function getSkillFilePath(name: string): string {
    if (!isSafeSkillName(name)) {
        throw new Error("Invalid skill name.");
    }
    const abs = resolve(join(SKILLS_DIR, name, "SKILL.md"));
    const rel = relative(SKILLS_DIR, abs);
    if (rel.startsWith("..") || rel.includes("/../")) {
        throw new Error("Invalid skill path.");
    }
    return abs;
}

export async function listSkills(): Promise<string[]> {
    if (!existsSync(SKILLS_DIR)) return [];
    const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
    const skills: string[] = [];
    for (const e of entries) {
        if (!e.isDirectory()) continue;
        const name = e.name;
        if (!isSafeSkillName(name)) continue;
        const skillPath = getSkillFilePath(name);
        try {
            const s = await stat(skillPath);
            if (s.isFile()) skills.push(name);
        } catch {
        }
    }
    return skills.sort();
}

export async function readSkill(name: string): Promise<string> {
    const path = getSkillFilePath(name);
    return await readFile(path, "utf-8");
}
