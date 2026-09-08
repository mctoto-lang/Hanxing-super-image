import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored 上游文件（文件头注明「勿局部修改，上游更新时整体重新 vendor」），
    // 不按本仓库规则改造
    "src/components/grok-ball/engine/grok-ball.js",
  ]),
  {
    rules: {
      // react-hooks v7 新增规则：禁止在 effect 内 setState。
      // 本项目业务组件大量使用「对话框 onOpen 重置表单 / fetch 数据后 setState」模式，
      // 属有意设计；逐个重构（迁 SWR/useAsync 数据层）有行为风险，留待专项统一处理。
      // 其它 v7 严格规则（refs/purity/exhaustive-deps 等）保持开启。
      "react-hooks/set-state-in-effect": "off",
      // 约定：以 _ 开头的参数/变量表示「有意未使用」（如 useActionState 的 prev、
      // 回调中不需要的位置参数），与 @typescript-eslint 社区惯例一致。
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // `declare namespace` 是模块类型增强的唯一写法（如 React 19 的
      // declare module "react" { namespace JSX } 注册自定义元素），放行；
      // 运行时 namespace（含编译产物的 IIFE 模拟）仍然禁止。
      "@typescript-eslint/no-namespace": [
        "error",
        { allowDeclarations: true },
      ],
    },
  },
]);

export default eslintConfig;
