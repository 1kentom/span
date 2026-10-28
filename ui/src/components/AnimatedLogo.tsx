import "../styles/animated-logo.css";

/** The supplied artwork is kept intact. Motion is confined to its fixed-size wrapper. */
export function AnimatedLogo(props: { size?: number; label?: string; class?: string }) {
  const width = () => props.size || 120;
  return <span class={`animated-logo ${props.class || ""}`} role="img" aria-label={props.label || "span"} style={{ width: `${width()}px`, height: `${width() * 969 / 916}px` }}>
    <img class="animated-logo-artwork" src="/span-logo.svg" alt="" width="916" height="969" draggable={false} />
  </span>;
}
