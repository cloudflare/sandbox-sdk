import { useEffect, useState } from "react";

export default function App() {
	const [sandboxUrl, setSandboxUrl] = useState(null);

	useEffect(() => {
		console.log("loading");
		fetch("/api/sandbox")
			.then((r) => r.json())
			.then((data) => setSandboxUrl(data.url))
			.catch((err) => console.error(err));
	}, []);
	console.log("sandboxURL", sandboxUrl);

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				height: "100dvh",
				fontFamily: "sans-serif",
			}}
		>
			<header
				style={{
					padding: "12px 16px",
					background: "#1e1e2e",
					color: "#cdd6f4",
					fontSize: 13,
					flexShrink: 0,
				}}
			>
				Cloudflare Sandbox cats &mdash; Vite + React (host HMR enabled)
			</header>
			{sandboxUrl ? (
				<iframe
					title="Sandbox"
					src={sandboxUrl}
					style={{ flex: 1, border: "none", width: "100%" }}
				/>
			) : (
				<p style={{ padding: 16, color: "#666" }}>Starting sandbox&hellip;</p>
			)}
		</div>
	);
}
