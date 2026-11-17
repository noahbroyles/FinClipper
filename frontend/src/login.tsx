// Entry point of the sign in page (templates/login.html).
import { render } from "preact";
import { LoginPage } from "./components/LoginPage";

render(<LoginPage />, document.getElementById("app")!);
