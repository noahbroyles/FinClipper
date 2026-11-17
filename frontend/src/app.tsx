// Entry point of the single page app (templates/app.html).
import { render } from "preact";
import { App } from "./components/App";

render(<App />, document.getElementById("app")!);
