<script setup lang="ts">
import { ref } from "vue";
import ExampleCounter from "./ExampleCounter.vue";

const message = ref("Hello from Vize plugin with Rspack!");
</script>

<template>
  <div class="app">
    <h1 class="text-3xl font-bold text-center text-[#42b883]">
      {{ message }}
    </h1>
    <ExampleCounter />
  </div>
</template>

<style scoped>
.app {
  font-family: system-ui, sans-serif;
  text-align: center;
  padding: 2rem;
}
</style>
