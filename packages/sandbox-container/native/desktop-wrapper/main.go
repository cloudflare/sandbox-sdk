package main

/*
#include <stdlib.h>
*/
import "C"
import (
	"os"
	"strings"

	"github.com/go-vgo/robotgo"
)

func init() {
	if os.Getenv("DISPLAY") == "" {
		os.Setenv("DISPLAY", ":99")
	}
}

//export Move
func Move(x, y C.int) *C.char {
	robotgo.Move(int(x), int(y))
	return C.CString("")
}

//export MoveSmooth
func MoveSmooth(x, y C.int, low, high C.double) *C.char {
	ok := robotgo.MoveSmooth(int(x), int(y), float64(low), float64(high))
	if !ok {
		return C.CString("smooth move failed to reach target")
	}
	return C.CString("")
}

//export Click
func Click(button *C.char, count C.int) *C.char {
	btn := C.GoString(button)
	n := int(count)
	if n <= 0 {
		n = 1
	}
	var err error
	switch {
	case n == 1:
		err = robotgo.Click(btn, false)
	case n == 2:
		err = robotgo.Click(btn, true)
	default:
		err = robotgo.MultiClick(btn, n)
	}
	if err != nil {
		return C.CString(err.Error())
	}
	return C.CString("")
}

//export Scroll
func Scroll(x, y C.int) *C.char {
	robotgo.Scroll(int(x), int(y))
	return C.CString("")
}

//export TypeText
func TypeText(text *C.char, pid C.int) *C.char {
	robotgo.Type(C.GoString(text), int(pid))
	return C.CString("")
}

//export KeyTap
func KeyTap(key *C.char, modifiers *C.char) *C.char {
	k := C.GoString(key)
	m := C.GoString(modifiers)
	var args []interface{}
	if m != "" {
		mods := strings.Split(m, "+")
		args = append(args, mods)
	}
	err := robotgo.KeyTap(k, args...)
	if err != nil {
		return C.CString(err.Error())
	}
	return C.CString("")
}

//export GetScreenSize
func GetScreenSize(w, h *C.int) {
	// robotgo.GetScreenSize() uses C-based XGetMainDisplay() singleton which
	// returns 0 in c-shared mode. GetDisplayBounds uses pure-Go xgb instead.
	_, _, width, height := robotgo.GetDisplayBounds(0)
	*w = C.int(width)
	*h = C.int(height)
}

//export Screenshot
func Screenshot(path *C.char, x, y, w, h C.int) *C.char {
	p := C.GoString(path)
	// robotgo.Capture uses pure-Go xgb sockets. robotgo.SaveCapture uses
	// C-based XGetImage which segfaults in c-shared mode.
	img, err := robotgo.Capture(int(x), int(y), int(w), int(h))
	if err != nil {
		return C.CString(err.Error())
	}
	err = robotgo.Save(img, p)
	if err != nil {
		return C.CString(err.Error())
	}
	return C.CString("")
}

//export GetMousePos
func GetMousePos(x, y *C.int) {
	mx, my := robotgo.Location()
	*x = C.int(mx)
	*y = C.int(my)
}

//export MouseDown
func MouseDown(button *C.char) *C.char {
	err := robotgo.MouseDown(C.GoString(button))
	if err != nil {
		return C.CString(err.Error())
	}
	return C.CString("")
}

//export MouseUp
func MouseUp(button *C.char) *C.char {
	err := robotgo.MouseUp(C.GoString(button))
	if err != nil {
		return C.CString(err.Error())
	}
	return C.CString("")
}

//export KeyDown
func KeyDown(key *C.char) *C.char {
	err := robotgo.KeyDown(C.GoString(key))
	if err != nil {
		return C.CString(err.Error())
	}
	return C.CString("")
}

//export KeyUp
func KeyUp(key *C.char) *C.char {
	err := robotgo.KeyUp(C.GoString(key))
	if err != nil {
		return C.CString(err.Error())
	}
	return C.CString("")
}

// Required for c-shared build mode
func main() {}
