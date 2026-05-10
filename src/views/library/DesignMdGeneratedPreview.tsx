import { useMemo } from "react";
import type { DesignMdContent } from "../../types";
import { buildBoard } from "../../lib/designMdSpecimenBuilder";
import { generateBoardHtml } from "../../lib/designMdHtmlGenerator";

interface Props {
  activeContent: DesignMdContent;
}

export function DesignMdGeneratedPreview({ activeContent }: Props) {
  const srcDoc = useMemo(() => {
    const board = buildBoard(
      activeContent.slug,
      activeContent.title,
      activeContent.description,
      activeContent.content,
    );
    return generateBoardHtml(board);
  }, [activeContent]);

  return (
    <div className="design-md-specimen-frame-wrap">
      <iframe
        className="design-md-specimen-frame"
        srcDoc={srcDoc}
        sandbox=""
        title={`Design system board: ${activeContent.title}`}
      />
      <div className="design-md-specimen-note">
        Generated from DESIGN.md
      </div>
    </div>
  );
}
