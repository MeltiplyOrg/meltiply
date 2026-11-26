import type { HTMLAttributes } from "react";
import { Heading } from "fumadocs-ui/components/heading";

type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

function headingRenderer(as: HeadingTag) {
  return function DocsHeading(props: HTMLAttributes<HTMLHeadingElement>) {
    return <Heading {...props} as={as} data-docs-heading="" />;
  };
}

export const docsHeadingComponents = {
  h1: headingRenderer("h1"),
  h2: headingRenderer("h2"),
  h3: headingRenderer("h3"),
  h4: headingRenderer("h4"),
  h5: headingRenderer("h5"),
  h6: headingRenderer("h6"),
};
