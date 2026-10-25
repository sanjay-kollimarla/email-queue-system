import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach } from "bun:test";

// a DOM for component tests; installed once for the whole test run
GlobalRegistrator.register({ url: "http://localhost/" });

const { cleanup } = await import("@testing-library/react");
afterEach(() => cleanup());
