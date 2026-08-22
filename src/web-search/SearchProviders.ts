import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import {BraveSearchProvider} from "./providers/BraveSearchProvider.js";
import {DuckDuckGoSearchProvider} from "./providers/DuckDuckGoSearchProvider.js";
import {NativeSearchProvider} from "./providers/NativeSearchProvider.js";
import {SearXngSearchProvider} from "./providers/SearXngSearchProvider.js";
import {SerperSearchProvider} from "./providers/SerperSearchProvider.js";
import {TavilySearchProvider} from "./providers/TavilySearchProvider.js";
import {WebSearchProviderId, type WebSearchProvider} from "./SearchProvider.js";
import type {WebSearchConfig} from "./WebSearchConfig.js";

export function createSearchProviders(config: WebSearchConfig, context: ExtensionContext): WebSearchProvider[] {
    return config.providers.map((provider) => {
        switch (provider) {
            case WebSearchProviderId.NATIVE:
                return new NativeSearchProvider(context);
            case WebSearchProviderId.SEARXNG:
                return new SearXngSearchProvider(config.searxng);
            case WebSearchProviderId.BRAVE:
                return new BraveSearchProvider(config.brave);
            case WebSearchProviderId.TAVILY:
                return new TavilySearchProvider(config.tavily);
            case WebSearchProviderId.SERPER:
                return new SerperSearchProvider(config.serper);
            case WebSearchProviderId.DUCKDUCKGO:
                return new DuckDuckGoSearchProvider();
        }
    });
}
