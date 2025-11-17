/**
 * Cloudflare-style decorative corner squares
 * 14px squares positioned at container corners
 */
export default function CornerSquares() {
  const squareClasses =
    'absolute w-[14px] h-[14px] bg-bg-cream border border-border-beige rounded-[3px]';

  return (
    <>
      <div className={`${squareClasses} -top-[7px] -left-[7px]`} />
      <div className={`${squareClasses} -top-[7px] -right-[7px]`} />
      <div className={`${squareClasses} -bottom-[7px] -left-[7px]`} />
      <div className={`${squareClasses} -bottom-[7px] -right-[7px]`} />
    </>
  );
}
