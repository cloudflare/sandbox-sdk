package main

/*
#include <stdlib.h>
*/
import "C"
import (
	"strings"
	"unsafe"

	"github.com/go-vgo/robotgo"
)

//export Move
func Move(x, y C.int) {
	robotgo.Move(int(x), int(y))
}

//export MoveSmooth
func MoveSmooth(x, y C.int, low, high C.double) {
	robotgo.MoveSmooth(int(x), int(y), float64(low), float64(high))
}

//export Click
func Click(button *C.char, double C.int) {
	btn := C.GoString(button)
	isDouble := double != 0
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
	var mods []string
	if m != "" {
		mods = strings.Split(m, "+")
	}
	err := robotgo.KeyTap(k, mods...)
	if err != "" {
		return C.CString(err)
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
func SaveCapture(path *C.char, x, y, w, h C.int) {
	p := C.GoString(path)
	robotgo.SaveCapture(p, int(x), int(y), int(w), int(h))
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
