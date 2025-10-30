import type { Sandbox } from '@cloudflare/sandbox';
import { errorResponse, jsonResponse, parseJsonBody } from '../http';

export async function setupNextjs(sandbox: Sandbox<unknown>, request: Request) {
  try {
    const body = await parseJsonBody(request);
    const { projectName = 'my-nextjs-app' } = body;

    // Step 1: Create Next.js app
    await sandbox.exec(
      `npx create-next-app@latest ${projectName} --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --no-turbopack --yes`
    );

    // Step 2: Install dependencies (already done by create-next-app)
    // Step 3: Start dev server on port 8080
    const process = await sandbox.startProcess(`npm run dev -- --port 8080`, {
      cwd: projectName
    });

    // Step 4: Wait a moment for server to start
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Step 5: Expose port
    const hostname = new URL(request.url).host;
    const preview = await sandbox.exposePort(8080, {
      name: 'Next.js Dev Server',
      hostname
    });

    return jsonResponse({
      success: true,
      projectName,
      processId: process.id,
      previewUrl: preview.url,
      message: 'Next.js project created and running!'
    });
  } catch (error: any) {
    console.error('Error setting up Next.js:', error);
    return errorResponse(`Failed to setup Next.js: ${error.message}`);
  }
}

export async function setupReact(sandbox: Sandbox<unknown>, request: Request) {
  try {
    const body = await parseJsonBody(request);
    const { projectName = 'my-react-app' } = body;

    // Step 1: Create React app
    await sandbox.exec(
      `npx create-react-app ${projectName} --template typescript`
    );

    // Step 2: Start dev server on port 8080
    const process = await sandbox.startProcess(`npm start`, {
      cwd: projectName,
      env: {
        BROWSER: 'none', // Prevent browser from opening
        PORT: '8080' // Set React dev server to use port 8080
      }
    });

    // Step 3: Wait for server to start
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Step 4: Expose port
    const hostname = new URL(request.url).host;
    const preview = await sandbox.exposePort(8080, {
      name: 'React Dev Server',
      hostname
    });

    return jsonResponse({
      success: true,
      projectName,
      processId: process.id,
      previewUrl: preview.url,
      message: 'React project created and running!'
    });
  } catch (error: any) {
    console.error('Error setting up React:', error);
    return errorResponse(`Failed to setup React: ${error.message}`);
  }
}

export async function setupVue(sandbox: Sandbox<unknown>, request: Request) {
  try {
    const body = await parseJsonBody(request);
    const { projectName = 'my-vue-app' } = body;

    // Step 1: Create Vue app
    await sandbox.exec(
      `npm create vue@latest ${projectName} -- --typescript --jsx --router --pinia --vitest --cypress --eslint --prettier --yes`
    );

    // Step 2: Install dependencies
    await sandbox.exec(`cd ${projectName} && npm install`);

    // Step 3: Start dev server on port 8080
    const process = await sandbox.startProcess(`npm run dev -- --port 8080`, {
      cwd: projectName
    });

    // Step 4: Wait for server to start
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Step 5: Expose port
    const hostname = new URL(request.url).host;
    const preview = await sandbox.exposePort(8080, {
      name: 'Vue Dev Server',
      hostname
    });

    return jsonResponse({
      success: true,
      projectName,
      processId: process.id,
      previewUrl: preview.url,
      message: 'Vue project created and running!'
    });
  } catch (error: any) {
    console.error('Error setting up Vue:', error);
    return errorResponse(`Failed to setup Vue: ${error.message}`);
  }
}

export async function setupStatic(sandbox: Sandbox<unknown>, request: Request) {
  try {
    const body = await parseJsonBody(request);
    const { projectName = 'my-static-site' } = body;

    // Step 1: Create directory and basic HTML
    await sandbox.mkdir(projectName);

    // Step 2: Create basic HTML file
    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>My Static Site</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
        h1 { color: #333; }
        .container { background: #f9f9f9; padding: 20px; border-radius: 8px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Welcome to Your Static Site!</h1>
        <p>This is a simple static website created with the Cloudflare Sandbox SDK.</p>
        <p>You can edit the files and see changes in real-time.</p>
        <h2>Quick Start:</h2>
        <ul>
            <li>Edit <code>index.html</code> to modify this page</li>
            <li>Add CSS files in a <code>css/</code> directory</li>
            <li>Add JavaScript files in a <code>js/</code> directory</li>
        </ul>
    </div>
</body>
</html>`;

    await sandbox.writeFile(`${projectName}/index.html`, htmlContent);

    // Step 3: Start simple HTTP server on port 8080
    const process = await sandbox.startProcess(`python3 -m http.server 8080`, {
      cwd: projectName
    });

    // Step 4: Wait for server to start
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Step 5: Expose port
    const hostname = new URL(request.url).host;
    const preview = await sandbox.exposePort(8080, {
      name: 'Static Site Server',
      hostname
    });

    return jsonResponse({
      success: true,
      projectName,
      processId: process.id,
      previewUrl: preview.url,
      message: 'Static site created and running!'
    });
  } catch (error: any) {
    console.error('Error setting up static site:', error);
    return errorResponse(`Failed to setup static site: ${error.message}`);
  }
}
