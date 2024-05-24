import markdown from "markdown-it";

import { Component, ContextAwareRendererComponent } from "../components";
import { type RendererEvent, MarkdownEvent, type PageEvent } from "../events";
import { Option, type Logger, renderElement } from "../../utils";
import { highlight, isLoadedLanguage, isSupportedLanguage } from "../../utils/highlighter";
import type { BundledTheme } from "shiki" with { "resolution-mode": "import" };
import { escapeHtml, getTextContent } from "../../utils/html";
import type { DefaultTheme } from "..";
import { Slugger } from "./default/DefaultTheme";
import { anchorIcon } from "./default/partials/anchor-icon";
import type { DefaultThemeRenderContext } from "..";
import { Comment, type CommentDisplayPart } from "../../models";

let defaultSlugger: Slugger | undefined;
function getDefaultSlugger(logger: Logger) {
    if (!defaultSlugger) {
        logger.warn(logger.i18n.custom_theme_does_not_define_getSlugger());
        defaultSlugger = new Slugger();
    }
    return defaultSlugger;
}

/**
 * Implements markdown and relativeURL helpers for templates.
 * @internal
 */
@Component({ name: "marked" })
export class MarkedPlugin extends ContextAwareRendererComponent {
    @Option("lightHighlightTheme")
    accessor lightTheme!: BundledTheme;

    @Option("darkHighlightTheme")
    accessor darkTheme!: BundledTheme;

    @Option("markdownItOptions")
    accessor markdownItOptions!: Record<string, unknown>;

    private parser?: markdown;

    /**
     * This needing to be here really feels hacky... probably some nicer way to do this.
     * Revisit when adding support for arbitrary pages in 0.26.
     */
    private renderContext: DefaultThemeRenderContext = null!;
    private lastHeaderSlug = "";

    /**
     * Create a new MarkedPlugin instance.
     */
    override initialize() {
        super.initialize();
        this.listenTo(this.owner, MarkdownEvent.PARSE, this.onParseMarkdown);
    }

    /**
     * Highlight the syntax of the given text using HighlightJS.
     *
     * @param text  The text that should be highlighted.
     * @param lang  The language that should be used to highlight the string.
     * @return A html string with syntax highlighting.
     */
    public getHighlighted(text: string, lang?: string): string {
        lang = lang || "typescript";
        lang = lang.toLowerCase();
        if (!isSupportedLanguage(lang)) {
            this.application.logger.warn(
                this.application.i18n.unsupported_highlight_language_0_not_highlighted_in_comment_for_1(
                    lang,
                    this.page?.model.getFriendlyFullName() ?? "(unknown)",
                ),
            );
            return text;
        }
        if (!isLoadedLanguage(lang)) {
            this.application.logger.warn(
                this.application.i18n.unloaded_language_0_not_highlighted_in_comment_for_1(
                    lang,
                    this.page?.model.getFriendlyFullName() ?? "(unknown)",
                ),
            );
            return text;
        }

        return highlight(text, lang);
    }

    /**
     * Parse the given markdown string and return the resulting html.
     *
     * @param input  The markdown string that should be parsed.
     * @returns The resulting html string.
     */
    public parseMarkdown(
        input: string | readonly CommentDisplayPart[],
        page: PageEvent<any>,
        context: DefaultThemeRenderContext,
    ) {
        let markdown = input;
        if (typeof markdown !== "string") {
            markdown = Comment.displayPartsToMarkdown(markdown, context.urlTo, !!this.markdownItOptions["html"]);
        }

        this.renderContext = context;
        const event = new MarkdownEvent(MarkdownEvent.PARSE, page, markdown, markdown);

        this.owner.trigger(event);
        this.renderContext = null!;
        return event.parsedText;
    }

    /**
     * Triggered before the renderer starts rendering a project.
     *
     * @param event  An event object describing the current render operation.
     */
    protected override onBeginRenderer(event: RendererEvent) {
        super.onBeginRenderer(event);
        this.setupParser();
    }

    private getSlugger() {
        if ("getSlugger" in this.owner.theme!) {
            return (this.owner.theme as DefaultTheme).getSlugger(this.page!.model);
        }
        return getDefaultSlugger(this.application.logger);
    }

    /**
     * Creates an object with options that are passed to the markdown parser.
     *
     * @returns The options object for the markdown parser.
     */
    private setupParser() {
        this.parser = markdown({
            ...this.markdownItOptions,
            highlight: (code, lang) => {
                code = highlight(code, lang || "ts");
                code = code.replace(/\n$/, "") + "\n";

                if (!lang) {
                    return `<pre><code>${code}</code><button>Copy</button></pre>\n`;
                }

                return `<pre><code class="${escapeHtml(lang)}">${code}</code><button type="button">Copy</button></pre>\n`;
            },
        });

        const loader = this.application.options.getValue("markdownItLoader");
        loader(this.parser);

        // Add anchor links for headings in readme, and add them to the "On this page" section
        this.parser.renderer.rules["heading_open"] = (tokens, idx) => {
            const token = tokens[idx];
            const content = tokens[idx + 1].content;
            const level = token.markup.length;

            const slug = this.getSlugger().slug(content);
            this.lastHeaderSlug = slug;

            // Prefix the slug with an extra `md:` to prevent conflicts with TypeDoc's anchors.
            this.page!.pageHeadings.push({
                link: `#md:${slug}`,
                text: getTextContent(content),
                level,
            });

            return `<a id="md:${slug}" class="tsd-anchor"></a><${token.tag} class="tsd-anchor-link">`;
        };
        this.parser.renderer.rules["heading_close"] = (tokens, idx) => {
            return `${renderElement(anchorIcon(this.renderContext, `md:${this.lastHeaderSlug}`))}</${tokens[idx].tag}>`;
        };

        // Rewrite anchor links inline in a readme file to links targeting the `md:` prefixed anchors
        // that TypeDoc creates.
        this.parser.renderer.rules["link_open"] = (tokens, idx, options, _env, self) => {
            const token = tokens[idx];
            const href = token.attrGet("href")?.replace(/^#(?:md:)?(.+)/, "#md:$1");
            if (href) {
                token.attrSet("href", href);
            }
            return self.renderToken(tokens, idx, options);
        };
    }

    /**
     * Triggered when {@link MarkedPlugin} parses a markdown string.
     *
     * @param event
     */
    onParseMarkdown(event: MarkdownEvent) {
        event.parsedText = this.parser!.render(event.parsedText);
    }
}
