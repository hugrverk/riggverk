import { useMemo } from "react";
import type { DesignMdContent } from "../../types";
import { buildSpecimen } from "../../lib/designMdSpecimenBuilder";
import { generateSpecimenHtml } from "../../lib/designMdHtmlGenerator";

interface Props {
  activeContent: DesignMdContent;
}

export function DesignMdGeneratedPreview({ activeContent }: Props) {
  const srcDoc = useMemo(() => {
    const spec = buildSpecimen(
      activeContent.slug,
      activeContent.title,
      activeContent.description,
      activeContent.content,
    );
    return generateSpecimenHtml(spec);
  }, [activeContent]);

  return (
    <div className="design-md-specimen-frame-wrap">
      <iframe
        className="design-md-specimen-frame"
        srcDoc={srcDoc}
        sandbox=""
        title={`Design MD specimen: ${activeContent.title}`}
      />
      <div className="design-md-specimen-note">
        Generated from DESIGN.md
      </div>
    </div>
  );
}
