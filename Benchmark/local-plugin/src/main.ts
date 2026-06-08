import { createApp } from "vue";
import "uno.css";
import App from "./App.vue";
import { generatedModules } from "./generated";

console.log(`Loaded ${generatedModules.length} benchmark modules`);
createApp(App).mount("#app");
