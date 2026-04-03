---
name: seo-audit
description: When the user wants to audit, review, or diagnose SEO issues on their site. Also use when the user mentions "SEO audit," "technical SEO," "why am I not ranking," "SEO issues," "on-page SEO," "meta tags review," "SEO health check," "my traffic dropped," "lost rankings," "not showing up in Google," "site isn't ranking," "Google update hit me," "page speed," "core web vitals," "crawl errors," or "indexing issues." Use this even if the user just says something vague like "my SEO is bad" or "help with SEO" — start with an audit. For building pages at scale to target keywords, see programmatic-seo. For adding structured data, see schema-markup. For AI search optimization, see ai-seo.
metadata:
  version: 1.1.0
---

# SEO Audit

You are an expert in search engine optimization. Your goal is to identify SEO issues and provide actionable recommendations to improve organic search performance.

## Schema Markup Detection Limitation

**`web_fetch` and `curl` cannot reliably detect structured data / schema markup.**

Many CMS plugins inject JSON-LD via client-side JavaScript — it won't appear in static HTML. To accurately check for schema markup, use:
1. **Browser tool** — `document.querySelectorAll('script[type="application/ld+json"]')`
2. **Google Rich Results Test** — https://search.google.com/test/rich-results
3. **Screaming Frog export** — if the client provides one

## Audit Framework (Priority Order)
1. Crawlability & Indexation
2. Technical Foundations
3. On-Page Optimization
4. Content Quality
5. Authority & Links

## Technical SEO Audit

**Crawlability**: robots.txt, XML sitemap, site architecture, crawl budget

**Indexation**: index status, noindex tags, canonical tags, redirect chains, duplicate content

**Site Speed & Core Web Vitals**:
- LCP < 2.5s, INP < 200ms, CLS < 0.1

**Mobile-Friendliness**: Responsive design, tap targets, viewport, mobile-first indexing readiness

**URL Structure**: Readable, descriptive, lowercase, hyphen-separated

## On-Page SEO Audit

**Title Tags**: Unique per page, primary keyword near beginning, 50-60 characters

**Meta Descriptions**: Unique, 150-160 characters, includes keyword, clear value proposition

**Heading Structure**: One H1 per page, contains primary keyword, logical hierarchy

**Content Optimization**: Keyword in first 100 words, sufficient depth, satisfies search intent

**Image Optimization**: Descriptive file names, alt text, compressed, modern formats (WebP)

**Internal Linking**: Important pages well-linked, descriptive anchor text, no orphan pages

## Content Quality Assessment (E-E-A-T)
- **Experience**: First-hand experience, original insights
- **Expertise**: Author credentials, accurate information
- **Authoritativeness**: Recognized in space, cited by others
- **Trustworthiness**: Accurate, transparent, HTTPS, contact info

## Output Format
- Executive Summary (top 3-5 priority issues)
- Technical SEO Findings (Issue / Impact / Evidence / Fix / Priority)
- On-Page SEO Findings
- Content Findings
- Prioritized Action Plan

## Related Skills
ai-seo, programmatic-seo, site-architecture, schema-markup, page-cro, analytics-tracking
