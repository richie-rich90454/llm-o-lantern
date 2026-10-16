import type { DialogueRequest } from "../data/DialogueRequest";
import type { ConversationMessage } from "../data/DialogueRequest";
import type { DialogueResponse } from "../data/DialogueResponse";
import type { SpeechResult, TranscriptionResult } from "../data/SpeechResult";
import type { SpeechTiming } from "../data/SpeechTiming";
import type { FacialAnimationTrack } from "../data/FacialAnimationTrack";
import type { PluginSelection } from "./ApplicationConfiguration";
import type { ApplicationLogger } from "./ApplicationLogger";

export const PLUGIN_CATEGORIES = [
  "dialogue",
  "personality",
  "speech-recognition",
  "speech-synthesis",
  "lip-sync",
  "memory",
  "character",
  "microphone",
  "audio-playback"
] as const;

export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];

export function isPluginCategory(value: string): value is PluginCategory {
  return (PLUGIN_CATEGORIES as readonly string[]).includes(value);
}

/**
 * The methods the plugin manager requires for each category. A plugin may
 * declare more, but these must exist or startup fails with a clear error.
 */
export const CATEGORY_REQUIRED_METHODS: Record<PluginCategory, readonly string[]> = {
  dialogue: ["generateResponse"],
  personality: [
    "buildInstructions",
    "getAllowedEmotions",
    "getAllowedDeliveries",
    "getResponseCharacterLimit",
    "getGreetingLine",
    "matchesSecretPhrase"
  ],
  "speech-recognition": ["transcribe"],
  "speech-synthesis": ["synthesize"],
  "lip-sync": ["generateTrack"],
  memory: ["addMessage", "getRecentMessages", "clearSession", "clearAll"],
  character: ["createModel", "getCapabilities", "applyFacialState", "dispose"],
  microphone: ["start", "stop", "isCapturing"],
  "audio-playback": ["prepare", "play", "stop", "isPlaying", "getPlaybackSeconds", "dispose"]
};

/**
 * The documented plugin convention. Plugins are ordinary classes with these
 * fields; the manager validates them at startup instead of relying on a
 * TypeScript interface declaration.
 */
export type PluginLike = {
  readonly id: string;
  readonly version: string;
  readonly category: PluginCategory;
  readonly dependencies?: readonly string[];
  initialize?(): Promise<void>;
  shutdown?(): Promise<void>;
  isAvailable?(): Promise<boolean>;
  getDisplayName?(): string;
};

export type DialoguePluginShape = {
  generateResponse(request: DialogueRequest, signal: AbortSignal): Promise<DialogueResponse>;
};

export type PersonalitySecretMatch = {
  phrase: string;
  text: string;
  emotion: string;
  delivery: string;
};

export type PersonalityPluginShape = {
  buildInstructions(): string;
  getAllowedEmotions(): readonly string[];
  getAllowedDeliveries(): readonly string[];
  getResponseCharacterLimit(): number;
  getGreetingLine(): string;
  matchesSecretPhrase(text: string): PersonalitySecretMatch | null;
};

export type SpeechDeliveryOptions = {
  emotion: string;
  delivery: string;
};

export type SpeechSynthesisPluginShape = {
  synthesize(text: string, options: SpeechDeliveryOptions, signal: AbortSignal): Promise<SpeechResult>;
};

export type SpeechRecognitionPluginShape = {
  transcribe(audioWav: Uint8Array, sampleRate: number, signal: AbortSignal): Promise<TranscriptionResult>;
};

export type LipSyncPluginShape = {
  generateTrack(timing: SpeechTiming): FacialAnimationTrack;
};

export type SessionMemoryPluginShape = {
  addMessage(sessionId: string, message: ConversationMessage): void;
  getRecentMessages(sessionId: string, limit: number): ConversationMessage[];
  clearSession(sessionId: string): void;
  clearAll(): void;
};

export type MicrophonePluginShape = {
  start(): Promise<void>;
  stop(): void;
  isCapturing(): boolean;
};

export type AudioPlaybackPluginShape = {
  prepare(wavBytes: Uint8Array): Promise<void>;
  play(): void;
  stop(fadeMs?: number): void;
  isPlaying(): boolean;
  getPlaybackSeconds(): number;
  dispose(): void;
};

export type PluginFactory = (logger: ApplicationLogger) => PluginLike;

export class PluginRegistry {
  private readonly factories = new Map<string, PluginFactory>();

  add(id: string, factory: PluginFactory): void {
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error("Plugin factory id must be a non-empty string");
    }
    if (this.factories.has(id)) {
      throw new Error(`Duplicate plugin id "${id}" in registry`);
    }
    this.factories.set(id, factory);
  }

  has(id: string): boolean {
    return this.factories.has(id);
  }

  get(id: string): PluginFactory {
    const factory = this.factories.get(id);
    if (!factory) {
      const known = this.listIds();
      throw new Error(
        `No plugin registered under id "${id}". Registered plugins: ${known.length > 0 ? known.join(", ") : "(none)"}`
      );
    }
    return factory;
  }

  listIds(): string[] {
    return [...this.factories.keys()].sort();
  }
}

type SelectedPlugin = {
  id: string;
  expectedCategory: PluginCategory | null;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PluginManager {
  private readonly selections: PluginSelection;
  private readonly logger: ApplicationLogger;
  private readonly plugins = new Map<string, PluginLike>();
  private readonly primaryByCategory = new Map<PluginCategory, string>();
  private initializationOrder: string[] = [];
  private loaded = false;

  constructor(selections: PluginSelection, logger: ApplicationLogger) {
    this.selections = selections;
    this.logger = logger;
  }

  /**
   * Constructs, validates, and initializes the plugins selected in
   * configuration, in dependency order. When `categories` is given, only
   * those categories are loaded (used by the browser for its client-side
   * plugins).
   */
  async loadFromRegistry(registry: PluginRegistry, categories?: readonly PluginCategory[]): Promise<void> {
    if (this.loaded) {
      throw new Error("PluginManager can only load once");
    }
    const selected = this.collectSelections(categories);

    const constructed = new Map<string, PluginLike>();
    for (const entry of selected) {
      if (constructed.has(entry.id)) {
        throw new Error(`Plugin "${entry.id}" is selected more than once in configuration`);
      }
      const factory = registry.get(entry.id);
      let plugin: PluginLike;
      try {
        plugin = factory(this.logger.child("plugins"));
      } catch (error) {
        throw new Error(`Failed to construct plugin "${entry.id}": ${errorMessage(error)}`);
      }
      this.validateMetadata(plugin, entry);
      constructed.set(entry.id, plugin);
    }

    this.validateDependencies(constructed);
    const order = topologicalOrder(constructed);

    const initialized: string[] = [];
    for (const id of order) {
      const plugin = constructed.get(id) as PluginLike;
      try {
        if (typeof plugin.initialize === "function") {
          await plugin.initialize();
        }
        initialized.push(id);
      } catch (error) {
        for (let index = initialized.length - 1; index >= 0; index -= 1) {
          const processed = constructed.get(initialized[index]) as PluginLike;
          try {
            await processed.shutdown?.();
          } catch {
            // best effort cleanup during a failed startup
          }
        }
        throw new Error(`Plugin "${id}" failed to initialize: ${errorMessage(error)}`);
      }
    }

    this.plugins.clear();
    this.primaryByCategory.clear();
    for (const entry of selected) {
      const plugin = constructed.get(entry.id) as PluginLike;
      this.plugins.set(entry.id, plugin);
      if (entry.expectedCategory !== null) {
        this.primaryByCategory.set(entry.expectedCategory, entry.id);
      }
    }
    this.initializationOrder = order;
    this.loaded = true;
    this.logger.info("Plugins initialized", { order });
  }

  hasPlugin(id: string): boolean {
    return this.plugins.has(id);
  }

  hasCategory(category: PluginCategory): boolean {
    return this.primaryByCategory.has(category);
  }

  /**
   * Returns a loaded plugin. Startup validation guarantees the required
   * methods for its category exist, so the caller may request the shape
   * documented for that category.
   */
  getPlugin<TShape extends object = PluginLike>(id: string): TShape {
    const plugin = this.plugins.get(id);
    if (!plugin) {
      throw new Error(`Plugin "${id}" is not loaded`);
    }
    return plugin as unknown as TShape;
  }

  getByCategory<TShape extends object = PluginLike>(category: PluginCategory): TShape {
    const id = this.primaryByCategory.get(category);
    if (!id) {
      throw new Error(`No plugin is selected for category "${category}"`);
    }
    return this.getPlugin<TShape>(id);
  }

  listLoaded(): PluginLike[] {
    return [...this.plugins.values()];
  }

  getInitializationOrder(): string[] {
    return [...this.initializationOrder];
  }

  async shutdown(): Promise<void> {
    for (let index = this.initializationOrder.length - 1; index >= 0; index -= 1) {
      const id = this.initializationOrder[index];
      const plugin = this.plugins.get(id);
      if (!plugin) {
        continue;
      }
      try {
        await plugin.shutdown?.();
      } catch (error) {
        this.logger.error(`Plugin "${id}" failed to shut down cleanly`, { error: errorMessage(error) });
      }
    }
    this.plugins.clear();
    this.primaryByCategory.clear();
    this.initializationOrder = [];
    this.loaded = false;
  }

  private collectSelections(categories?: readonly PluginCategory[]): SelectedPlugin[] {
    const primaryEntries: [PluginCategory, string | null][] = [
      ["dialogue", this.selections.dialogue],
      ["personality", this.selections.personality],
      ["speech-recognition", this.selections.speechRecognition],
      ["speech-synthesis", this.selections.speechSynthesis],
      ["lip-sync", this.selections.lipSync],
      ["memory", this.selections.memory],
      ["character", this.selections.character],
      ["microphone", this.selections.microphone],
      ["audio-playback", this.selections.audioPlayback]
    ];

    const selected: SelectedPlugin[] = [];
    for (const [category, id] of primaryEntries) {
      if (id === null) {
        continue;
      }
      if (categories !== undefined && !categories.includes(category)) {
        continue;
      }
      selected.push({ id, expectedCategory: category });
    }

    // Additional plugins (for example the scripted dialogue fallback) are
    // server-side concerns; a category filter excludes them.
    if (categories === undefined) {
      for (const id of this.selections.additional) {
        selected.push({ id, expectedCategory: null });
      }
    }
    return selected;
  }

  private validateMetadata(plugin: PluginLike, selected: SelectedPlugin): void {
    if (typeof plugin !== "object" || plugin === null) {
      throw new Error(`Plugin factory for "${selected.id}" did not return a plugin object`);
    }
    if (typeof plugin.id !== "string" || plugin.id.trim() === "") {
      throw new Error(`Plugin "${selected.id}" must declare a non-empty string id`);
    }
    if (plugin.id !== selected.id) {
      throw new Error(`Plugin factory for "${selected.id}" returned a plugin with id "${plugin.id}"`);
    }
    if (typeof plugin.version !== "string" || plugin.version.trim() === "") {
      throw new Error(`Plugin "${plugin.id}" must declare a non-empty string version`);
    }
    if (typeof plugin.category !== "string" || !isPluginCategory(plugin.category)) {
      throw new Error(
        `Plugin "${plugin.id}" declares unknown category "${String(plugin.category)}". Known categories: ${PLUGIN_CATEGORIES.join(", ")}`
      );
    }
    if (selected.expectedCategory !== null && plugin.category !== selected.expectedCategory) {
      throw new Error(
        `Plugin "${plugin.id}" declares category "${plugin.category}" but configuration selects it as "${selected.expectedCategory}"`
      );
    }
    if (plugin.dependencies !== undefined) {
      if (!Array.isArray(plugin.dependencies) || plugin.dependencies.some((dependency) => typeof dependency !== "string" || dependency.trim() === "")) {
        throw new Error(`Plugin "${plugin.id}" dependencies must be an array of plugin id strings`);
      }
    }
    const requiredMethods = CATEGORY_REQUIRED_METHODS[plugin.category];
    for (const method of requiredMethods) {
      const candidate = (plugin as unknown as Record<string, unknown>)[method];
      if (typeof candidate !== "function") {
        throw new Error(
          `Plugin "${plugin.id}" (category "${plugin.category}") is missing required method "${method}"`
        );
      }
    }
  }

  private validateDependencies(constructed: Map<string, PluginLike>): void {
    for (const [id, plugin] of constructed) {
      for (const dependency of plugin.dependencies ?? []) {
        if (!constructed.has(dependency)) {
          throw new Error(`Plugin "${id}" depends on "${dependency}", which is not selected in configuration`);
        }
      }
    }
  }
}

/**
 * Kahn's algorithm over the dependency edges. Dependencies must initialize
 * before their dependents. Cycle members are reported by id.
 */
export function topologicalOrder(constructed: Map<string, PluginLike>): string[] {
  const ids = [...constructed.keys()];
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const id of ids) {
    inDegree.set(id, 0);
    dependents.set(id, []);
  }
  for (const id of ids) {
    const plugin = constructed.get(id) as PluginLike;
    for (const dependency of plugin.dependencies ?? []) {
      inDegree.set(id, (inDegree.get(id) as number) + 1);
      (dependents.get(dependency) as string[]).push(id);
    }
  }

  const queue: string[] = ids.filter((id) => inDegree.get(id) === 0);
  const order: string[] = [];
  let head = 0;
  while (head < queue.length) {
    const id = queue[head];
    head += 1;
    order.push(id);
    for (const dependent of dependents.get(id) as string[]) {
      const remaining = (inDegree.get(dependent) as number) - 1;
      inDegree.set(dependent, remaining);
      if (remaining === 0) {
        queue.push(dependent);
      }
    }
  }

  if (order.length !== ids.length) {
    const cyclic = ids.filter((id) => !order.includes(id));
    throw new Error(`Plugin dependency cycle detected among: ${cyclic.join(", ")}`);
  }
  return order;
}
