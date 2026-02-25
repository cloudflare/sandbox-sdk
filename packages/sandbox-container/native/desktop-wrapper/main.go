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
func Move(x, y C.int) {
	robotgo.Move(int(x), int(y))
}

//export MoveSmooth
func MoveSmooth(x, y C.int, low, high C.double) {
	robotgo.MoveSmooth(int(x), int(y), float64(low), float64(high))
}

//export Click
func Click(button *C.char, dblClick C.int) {
	btn := C.GoString(button)
	isDouble := dblClick != 0
	robotgo.Click(btn, isDouble)
}

//export Scroll
func Scroll(x, y C.int) {
	robotgo.Scroll(int(x), int(y))
}

//export TypeStr
func TypeStr(text *C.char, pid C.int) {
	robotgo.TypeStr(C.GoString(text), int(pid))
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
	width, height := robotgo.GetScreenSize()
	*w = C.int(width)
	*h = C.int(height)
}

//export SaveCapture
func SaveCapture(path *C.char, x, y, w, h C.int) *C.char {
	p := C.GoString(path)
	// Use robotgo.Capture (Go-native, xgb sockets) instead of
	// robotgo.SaveCapture (C-based, XGetImage) which segfaults in c-shared mode
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
func MouseDown(button *C.char) {
	robotgo.Toggle("down", C.GoString(button))
}

//export MouseUp
func MouseUp(button *C.char) {
	robotgo.Toggle("up", C.GoString(button))
}

//export KeyDown
func KeyDown(key *C.char) {
	robotgo.KeyToggle(C.GoString(key), "down")
}

//export KeyUp
func KeyUp(key *C.char) {
	robotgo.KeyToggle(C.GoString(key), "up")
}

// Required for c-shared build mode
func main() {}
