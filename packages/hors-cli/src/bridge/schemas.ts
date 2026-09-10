import { z } from "zod";

export const emptySchema = {};

export const addServiceSchema = {
  name: z.string(),
  uri: z.string(),
};

export const listSchema = {
  service: z.string(),
};

export const callSchema = {
  service: z.string(),
  fn: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
};

export const DESCRIPTIONS = {
  hors_status:
    "Report whether this profile is connected. hint is a command for the human to run in a visible terminal; never run it yourself.",
  hors_services: "List the local address book (name → URI). No network.",
  hors_add_service: "Add a name → URI entry to the local address book.",
  hors_list:
    "List tools on a service (unsigned). service is an address-book name, URL, resolver URI, or bare ENS name. Run this before hors_call for unfamiliar functions.",
  hors_call:
    "Sign and call a remote function. Run hors_list first for unfamiliar functions. A denied result is final unless challenge is present; the human — not the model — resolves challenges and registration.",
} as const;
