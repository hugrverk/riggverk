import { useMemo } from "react";
import type { DesignMdContent } from "../../types";
import { buildBoard } from "../../lib/designMdSpecimenBuilder";
import { generateBoardHtml } from "../../lib/designMdHtmlGenerator";
import { designMdDisplayTitle } from "../../lib/designMdDisplay";

interface Props {
  activeContent: DesignMdContent;
}

export function DesignMdGeneratedPreview({ activeContent }: Props) {
  const srcDoc = useMemo(() => {
    const board = buildBoard(
      activeContent.slug,
      designMdDisplayTitle(activeContent.slug),
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
        title={`Design system board: ${designMdDisplayTitle(activeContent.slug)}`}
      />
    </div>
  );
}
