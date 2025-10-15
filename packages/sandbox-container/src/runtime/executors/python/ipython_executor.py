#!/usr/bin/env python3
"""
IPython-based executor for clean Python code execution.
Uses IPython's built-in display formatter for rich outputs.
"""

import sys
import json
import traceback
import base64
from io import BytesIO

try:
    from IPython.core.interactiveshell import InteractiveShell
    from IPython.utils.capture import capture_output
except ImportError as e:
    print(json.dumps({
        "error": f"IPython import failed: {str(e)}",
        "python_path": sys.path
    }), flush=True)
    sys.exit(1)

# Create IPython shell instance
shell = InteractiveShell.instance()

# Configure for non-interactive use
shell.colors = 'NoColor'
shell.quiet = True
shell.ast_node_interactivity = 'last_expr'  # Only show the last expression

# Configure matplotlib backend for non-interactive use
import os
os.environ['MPLBACKEND'] = 'Agg'

# Send ready signal after IPython is initialized
print(json.dumps({"status": "ready", "version": "2.0.0"}), flush=True)

def capture_matplotlib_figures():
    """Capture any matplotlib figures that exist"""
    figures = []
    try:
        # Only import if matplotlib is already loaded
        if 'matplotlib.pyplot' in sys.modules:
            import matplotlib.pyplot as plt
            # Get all figure numbers
            fig_nums = plt.get_fignums()
            for fig_num in fig_nums:
                fig = plt.figure(fig_num)
                # Save to BytesIO buffer
                buf = BytesIO()
                fig.savefig(buf, format='png', bbox_inches='tight')
                buf.seek(0)
                # Encode to base64
                img_data = base64.b64encode(buf.read()).decode('utf-8')
                figures.append(img_data)
                buf.close()
            # Close all figures to prevent memory leaks
            plt.close('all')
    except Exception as e:
        pass  # Silently fail if matplotlib not available
    return figures

def execute_code(code):
    """Execute code using IPython's built-in display system."""
    result = {
        'stdout': '',
        'stderr': '',
        'error': None,
        'outputs': []
    }
    
    try:
        # Use capture_output to capture display() calls AND stdout/stderr
        with capture_output() as captured:
            # Execute code using IPython
            exec_result = shell.run_cell(code, store_history=False, silent=False)
        
        # Get captured stdout/stderr from capture_output
        result['stdout'] = captured.stdout
        result['stderr'] = captured.stderr
        
        # Handle execution errors
        if exec_result.error_in_exec:
            error = exec_result.error_in_exec
            result['error'] = {
                'type': error.__class__.__name__,
                'message': str(error),
                'traceback': '\n'.join(traceback.format_tb(error.__traceback__))
            }
        
        # Process display() outputs from capture_output
        for output in captured.outputs:
            # Check the structure of the output object
            if hasattr(output, 'data'):
                data = output.data
                metadata = getattr(output, 'metadata', {})
                
                # Process different MIME types
                if 'image/png' in data:
                    result['outputs'].append({
                        'type': 'image',
                        'data': data['image/png'],
                        'metadata': metadata.get('image/png', {})
                    })
                
                if 'image/jpeg' in data:
                    result['outputs'].append({
                        'type': 'jpeg',
                        'data': data['image/jpeg'],
                        'metadata': metadata.get('image/jpeg', {})
                    })
                
                if 'image/svg+xml' in data:
                    result['outputs'].append({
                        'type': 'svg',
                        'data': data['image/svg+xml'],
                        'metadata': metadata.get('image/svg+xml', {})
                    })
                
                if 'text/html' in data:
                    result['outputs'].append({
                        'type': 'html',
                        'data': data['text/html'],
                        'metadata': metadata.get('text/html', {})
                    })
                
                if 'application/json' in data:
                    result['outputs'].append({
                        'type': 'json',
                        'data': json.dumps(data['application/json']),
                        'metadata': metadata.get('application/json', {})
                    })
                
                if 'text/latex' in data:
                    result['outputs'].append({
                        'type': 'latex',
                        'data': data['text/latex'],
                        'metadata': metadata.get('text/latex', {})
                    })
                
                if 'text/markdown' in data:
                    result['outputs'].append({
                        'type': 'markdown',
                        'data': data['text/markdown'],
                        'metadata': metadata.get('text/markdown', {})
                    })
                
                if 'application/javascript' in data:
                    result['outputs'].append({
                        'type': 'javascript',
                        'data': data['application/javascript'],
                        'metadata': metadata.get('application/javascript', {})
                    })
                
                # Include plain text if nothing else was captured from this output
                if 'text/plain' in data and len(data) == 1:
                    result['outputs'].append({
                        'type': 'text',
                        'data': data['text/plain'],
                        'metadata': metadata.get('text/plain', {})
                    })
        
        # Capture any matplotlib figures that were created
        # This handles plt.show() calls
        matplotlib_figures = capture_matplotlib_figures()
        for fig_data in matplotlib_figures:
            result['outputs'].append({
                'type': 'image',
                'data': fig_data,
                'metadata': {}
            })
        
        # Also check if the last expression produced a result
        # Always process the last expression result (even if there were display outputs)
        if exec_result.result is not None:
            # Check if result is a dict or list that should be rendered as JSON
            if isinstance(exec_result.result, (dict, list)):
                result['outputs'].append({
                    'type': 'json',
                    'data': json.dumps(exec_result.result),
                    'metadata': {}
                })
            else:
                # Use IPython's display formatter to get all available representations
                formatted_dict, metadata = shell.display_formatter.format(exec_result.result)
                
                # Process all available MIME types in order of preference
                output_added = False
                
                # Images
                if 'image/png' in formatted_dict:
                    result['outputs'].append({
                        'type': 'image',
                        'data': formatted_dict['image/png'],
                        'metadata': metadata.get('image/png', {})
                    })
                    output_added = True
                
                if 'image/jpeg' in formatted_dict:
                    result['outputs'].append({
                        'type': 'jpeg',
                        'data': formatted_dict['image/jpeg'],
                        'metadata': metadata.get('image/jpeg', {})
                    })
                    output_added = True
                
                if 'image/svg+xml' in formatted_dict:
                    result['outputs'].append({
                        'type': 'svg',
                        'data': formatted_dict['image/svg+xml'],
                        'metadata': metadata.get('image/svg+xml', {})
                    })
                    output_added = True
                
                # HTML (pandas DataFrames often use this)
                if 'text/html' in formatted_dict:
                    result['outputs'].append({
                        'type': 'html',
                        'data': formatted_dict['text/html'],
                        'metadata': metadata.get('text/html', {})
                    })
                    # Don't set output_added for HTML - we want text too for DataFrames
                
                # JSON data
                if 'application/json' in formatted_dict:
                    result['outputs'].append({
                        'type': 'json',
                        'data': json.dumps(formatted_dict['application/json']),
                        'metadata': metadata.get('application/json', {})
                    })
                    output_added = True
                
                # LaTeX
                if 'text/latex' in formatted_dict:
                    result['outputs'].append({
                        'type': 'latex',
                        'data': formatted_dict['text/latex'],
                        'metadata': metadata.get('text/latex', {})
                    })
                    output_added = True
                
                # Markdown
                if 'text/markdown' in formatted_dict:
                    result['outputs'].append({
                        'type': 'markdown',
                        'data': formatted_dict['text/markdown'],
                        'metadata': metadata.get('text/markdown', {})
                    })
                    output_added = True
                
                # JavaScript
                if 'application/javascript' in formatted_dict:
                    result['outputs'].append({
                        'type': 'javascript',
                        'data': formatted_dict['application/javascript'],
                        'metadata': metadata.get('application/javascript', {})
                    })
                    output_added = True
                
                # Plain text - always include if no other output or if HTML present (for DataFrames)
                if 'text/plain' in formatted_dict:
                    # Include plain text if: no other output was added, OR if we have HTML (DataFrames)
                    has_html = any(o['type'] == 'html' for o in result.get('outputs', []))
                    if not output_added or has_html:
                        result['outputs'].append({
                            'type': 'text',
                            'data': formatted_dict['text/plain'],
                            'metadata': metadata.get('text/plain', {})
                        })
        
    except Exception as e:
        # Handle protocol-level errors
        result['error'] = {
            'type': type(e).__name__,
            'message': str(e),
            'traceback': traceback.format_exc()
        }
    
    return result

def main():
    """Main loop - read JSON requests, execute, return JSON responses."""
    
    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                break
            
            # Parse request
            request = json.loads(line.strip())
            
            # Execute code
            result = execute_code(request.get('code', ''))
            
            # Add execution ID to response
            result['executionId'] = request.get('executionId')
            result['success'] = result['error'] is None
            
            # Send response
            print(json.dumps(result), flush=True)
            
        except json.JSONDecodeError as e:
            # Invalid JSON
            error_response = {
                'error': {
                    'type': 'ProtocolError',
                    'message': f'Invalid JSON: {str(e)}'
                },
                'status': 'error'
            }
            print(json.dumps(error_response), flush=True)
            
        except KeyboardInterrupt:
            break
            
        except Exception as e:
            # Unexpected error
            error_response = {
                'error': {
                    'type': 'InternalError',
                    'message': f'Unexpected error: {str(e)}',
                    'traceback': traceback.format_exc()
                },
                'status': 'error'
            }
            print(json.dumps(error_response), flush=True)

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        # Send error as JSON to stdout so process pool can see it
        print(json.dumps({
            "error": f"Failed to start: {str(e)}",
            "traceback": traceback.format_exc()
        }), flush=True)
        sys.exit(1)