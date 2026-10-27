import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// The release check runs the suite next to cargo and other jobs; under that load a render can
// take longer than the default 1 s that findBy*/waitFor wait for. Waiting longer changes no
// assertion, it only stops slow-but-correct renders from failing.
configure({ asyncUtilTimeout: 5000 });
