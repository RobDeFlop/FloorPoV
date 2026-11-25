import { MotionConfig } from "motion/react";
import { Layout } from "./components/app/Layout";

function App() {
  // "user" drops transform and layout animations when Windows has animations turned off.
  return (
    <MotionConfig reducedMotion="user">
      <Layout />
    </MotionConfig>
  );
}

export default App;
